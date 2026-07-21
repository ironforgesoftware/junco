# TUI Follow-ups (#247–#253) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven follow-up issues filed from PR #246's review — one commit per issue, all on one branch, one PR.

**Architecture:** Three of the seven are test-only. Two extract a shared source of truth (a pure `prListColumns` builder; a `truncate` option on `StatRow`). One adds a width budget so the repo-scoped PR monitor drops its least-informative column instead of silently clipping the age column. One is documentation. Nothing changes runtime behavior outside the TUI.

**Tech Stack:** TypeScript strict ESM (NodeNext, Node ≥ 22.19), Ink 5 + ink-testing-library, vitest.

**Branch:** `feat/tui-followups`, already created off `origin/main` at `8ae7c56`.

## Global Constraints

- One commit per issue, in the task order below; each commit's subject ends with ` (#NNN)` so the issue auto-links. Never squash two issues into one commit.
- No new dependencies (exact-pinned repo). Strict TS ESM: relative imports carry `.js` specifiers.
- Rows never wrap: every fixed cell is `flexShrink={0}`, exactly one flexible cell per row, and list rows keep their `overflow="hidden"` belt.
- Never pipe vitest into a filter — the pipeline exits with the filter's status: `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"`.
- Adding a required field to a shared type breaks test fixtures at TYPECHECK only (vitest does not type-check): sweep with `npx tsc --noEmit -p tsconfig.eslint.json` and look only for NEW errors in files you touched (~57 pre-existing errors elsewhere are known noise).
- Ink tests: loop-until-condition via `tests/helpers/until.ts` — never a fixed `setTimeout` tick. `ink-testing-library` trims trailing whitespace at line ends; assert mid-line content or use the sibling-marker pattern from `tests/tuiPrimitives.test.tsx`.
- Prettier may reformat between your read and your edit: re-read before editing, and run `npx prettier --write` on touched files before committing.
- `npm run lint`, `npx tsc --noEmit -p tsconfig.eslint.json`, and the full suite must be green at EVERY commit.
- **No AI attribution in commits — no `Co-Authored-By`, no `Claude-Session` lines.** Verify with `git log -1 --format=%B` after each commit and amend if anything extra appears.
- The repo doubles as the maintainer's live runtime: never touch `config.json`, `tickets/`, `worktrees/`, and never run `junco start` here.

## File Map

| File                                             | Task    | Role                                                                     |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------ |
| `src/tui/components/PrList.tsx`                  | 1, 2, 5 | extract `prListColumns`; consume the width budget; hoist `isBotAuthored` |
| `tests/tuiPrColumns.test.tsx`                    | 1, 2    | pin derived widths; pin the budget drop                                  |
| `src/tui/App.tsx`                                | 2, 5    | pass `paneWidth` to the pane-3 monitor; section-window height            |
| `tests/tuiApp.test.tsx`                          | 3, 4    | restore stamp behavior tests; breadcrumb assertions                      |
| `tests/tuiActivityCard.test.tsx`                 | 4       | local-repo reserved-slot test                                            |
| `src/tui/components/IssueList.tsx`               | 5       | derive row widths from `COLUMNS`; hoist `isBotAuthored`                  |
| `src/tui/components/primitives/SectionStrip.tsx` | 5       | NEW — the band QueueView hand-rolls                                      |
| `src/tui/components/QueueView.tsx`               | 5       | consume `SectionStrip`                                                   |
| `src/tui/components/primitives/Rule.tsx`         | 5       | export `DETAIL_RULE_WIDTH`                                               |
| `src/tui/components/sections.tsx`                | 5       | use the constant                                                         |
| `src/tui/components/HelpModal.tsx`               | 5       | drop "pane 1/2/3" wording                                                |
| `src/tui/geometry.ts`                            | 5       | NEW `sectionRowsHeight`                                                  |
| `tests/tuiLocal.test.tsx`                        | 5       | replace the vacuous assertion                                            |
| `src/tui/components/primitives/StatRow.tsx`      | 6       | `truncate` option                                                        |
| `src/tui/components/RepoDetail.tsx`              | 5, 6    | rule constant; `truncate="start"` on path                                |
| `docs/dashboard.md`                              | 7       | derived-keys table accuracy                                              |

---

### Task 1: Extract `prListColumns` and pin the dataset-derived widths (#248)

**Why:** `b9a408e` sized the state-pill column from the visible dataset instead of the global `MAX_PR_BADGE_LEN`, but the existing regression test is satisfied by the `overflow="hidden"` belt alone — reverting the width derivation keeps the suite green. Extracting the width math into a pure builder makes it directly assertable (and gives Task 2 a single place to add the budget).

**Files:**

- Modify: `src/tui/components/PrList.tsx:73-95` (the in-component width block) and its two consumers (the `<TableHeader columns={columns} />` call at ~112 and the row cells at ~146-180)
- Test: `tests/tuiPrColumns.test.tsx`

**Interfaces:**

- Produces: `prListColumns(opts: { prs: DashPr[]; showNwo: boolean }): { columns: Column[]; pillInner: number; repoW: number; checksW: number }` exported from `src/tui/components/PrList.tsx`. Task 2 adds an optional `paneWidth` to the opts and a `showChecks` field to the result.

- [ ] **Step 1: Write the failing test**

Append to `tests/tuiPrColumns.test.tsx` (it already imports `pr` and `DashPr`; add `prListColumns` to the `PrList.js` import):

```tsx
describe("prListColumns (dataset-derived widths)", () => {
  const widthOf = (cols: ReturnType<typeof prListColumns>["columns"], label: string): number => {
    const c = cols.find((x) => x.label === label);
    if (c === undefined || c.width === "flex") throw new Error(`no fixed column "${label}"`);
    return c.width;
  };

  it("sizes the state column to the widest badge PRESENT, not the global max", () => {
    // Every fixture row is plain OPEN → "review-pending" (14), so the pill must
    // be 16 — NOT 19, which the global MAX_PR_BADGE_LEN ("changes-requested",
    // 17) would reserve.
    const benign = prListColumns({ prs: [pr(1, "one"), pr(2, "two")], showNwo: false });
    expect(benign.pillInner).toBe("review-pending".length);
    expect(widthOf(benign.columns, "state")).toBe("review-pending".length + 2);
  });

  it("grows the state column when a wider badge enters the dataset", () => {
    const withWide = prListColumns({
      prs: [pr(1, "one"), { ...pr(2, "two"), reviewDecision: "CHANGES_REQUESTED" } as DashPr],
      showNwo: false,
    });
    expect(withWide.pillInner).toBe("changes-requested".length);
    expect(widthOf(withWide.columns, "state")).toBe("changes-requested".length + 2);
  });

  it("never falls below the header labels' own widths", () => {
    const empty = prListColumns({ prs: [], showNwo: true });
    expect(empty.pillInner).toBe("state".length);
    expect(empty.repoW).toBe("repo".length);
    expect(empty.checksW).toBe("checks".length);
  });

  it("omits the repo column when showNwo is false", () => {
    const cols = prListColumns({ prs: [pr(1, "one")], showNwo: false }).columns;
    expect(cols.some((c) => c.label === "repo")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -5 /tmp/out`
Expected: exit 1 — `prListColumns` is not exported from `PrList.js`.

- [ ] **Step 3: Extract the builder**

In `src/tui/components/PrList.tsx`, move the width block out of the component to module scope, directly below the existing `NWO_MAX_WIDTH` export:

```tsx
/** Widest the age cell can need — `relTime` can emit "365d". */
const AGE_W = 4;

export interface PrListColumnOpts {
  prs: DashPr[];
  showNwo: boolean;
}

export interface PrListColumnSpec {
  columns: Column[];
  /** Inner pill width (badge text without the two pad spaces) — the Badge's `padTo`. */
  pillInner: number;
  repoW: number;
  checksW: number;
}

/** The single source of truth for this list's geometry: header cells and row
 * cells both read it, so they can never drift. Widths come from the CURRENT
 * dataset (or the header labels' own widths) — never from the selected row, so
 * moving the cursor can never shift a column. */
export function prListColumns({ prs, showNwo }: PrListColumnOpts): PrListColumnSpec {
  const badges = prs.map((p) => prStateMeta(derivePrState(p)).badge);
  const pillInner = Math.max("state".length, ...badges.map((b) => b.length), 0);
  const repoW = showNwo
    ? Math.min(NWO_MAX_WIDTH, Math.max("repo".length, ...prs.map((p) => p.nwo.length), 0))
    : 0;
  const checksW = Math.max("checks".length, ...prs.map((p) => checksToString(p.checks).length), 0);
  const columns: Column[] = [
    { label: "", width: 1 },
    { label: "", width: 1 },
    { label: "#", width: 5, align: "right" },
    { label: "title", width: "flex" },
    ...(showNwo ? [{ label: "repo", width: repoW } as Column] : []),
    { label: "checks", width: checksW },
    { label: "state", width: pillInner + 2 },
    { label: "age", width: AGE_W, align: "right" },
  ];
  return { columns, pillInner, repoW, checksW };
}
```

Then replace the component's width block (the `const AGE_W` … `const columns: Column[] = [...]` region inside `PrList`) with:

```tsx
const { columns, pillInner, repoW, checksW } = prListColumns({ prs, showNwo });
const PILL_W = pillInner + 2;
const metaOf = prs.map((p) => prStateMeta(derivePrState(p)));
```

Leave every row cell as-is — they already read `PILL_W`, `repoW`, `checksW`, `AGE_W`. (`AGE_W` is now module scope, so the row's `width={AGE_W}` still resolves.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"`
Expected: exit 0. Then the full suite: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/PrList.tsx tests/tuiPrColumns.test.tsx
git add src/tui/components/PrList.tsx tests/tuiPrColumns.test.tsx
git commit -m "test(tui): pin PrList's dataset-derived column widths (#248)"
git log -1 --format=%B   # must be the single subject line, no trailers
```

---

### Task 2: Width-budget the PR monitor so `age` survives (#247)

**Why:** In the pane-3 monitor at a 110-col terminal the interior is 40 columns, but a window containing a `changes-requested` row (pill 19) plus a wide checks string (9) needs 45. The `overflow="hidden"` belt keeps the frame intact but silently swallows the entire trailing **age** column — label and values — with no marker. The checks column is the right one to sacrifice: `derivePrState` already folds `checks-failing` / `checks-pending` into the lifecycle the state pill renders, so dropping it loses no information.

**Files:**

- Modify: `src/tui/components/PrList.tsx` (the `prListColumns` builder from Task 1 + the `PrListProps` interface + the row's checks cell)
- Modify: `src/tui/App.tsx` — the pane-3 `<PrList …>` render (inside the `view === "main" && body?.kind === "issues"` arm, wrapped in `<Box width={layout.previewWidth} …>`)
- Test: `tests/tuiPrColumns.test.tsx`

**Interfaces:**

- Consumes: `prListColumns({ prs, showNwo })` from Task 1.
- Produces: `prListColumns` gains `paneWidth?: number` in its opts and `showChecks: boolean` in its result; `PrList` gains prop `paneWidth?: number`.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("PrList narrow-pane overflow clamp (pane-3 @ 110-col geometry)", …)` block in `tests/tuiPrColumns.test.tsx` — it already defines `worstPrs`, `benignPrs`, and `HEIGHT`. Add a width-aware render helper and the assertions:

```tsx
function renderPaneBudgeted(prs: DashPr[], paneWidth: number): string {
  return (
    render(
      <Box width={paneWidth} height={HEIGHT}>
        <PrList
          prs={prs}
          selected={0}
          focused={true}
          height={HEIGHT}
          now={new Date("2026-07-20T12:00:00Z")}
          staleAt={null}
          window={{ start: 0, end: prs.length }}
          showNwo={false}
          paneWidth={paneWidth}
        />
      </Box>,
    ).lastFrame() ?? ""
  );
}

it("drops the checks column rather than the age column when the pane is tight", () => {
  const f = renderPaneBudgeted(worstPrs, 44);
  expect(f).toContain("age"); // the header cell survives…
  expect(f).toContain("1h"); // …and so do the row values
  expect(f).not.toContain("checks");
});

it("keeps the checks column when the pane is wide enough", () => {
  // previewWidth caps at 60 (layout.ts PREVIEW_CAP) — the widest pane 3 gets.
  const f = renderPaneBudgeted(worstPrs, 60);
  expect(f).toContain("checks");
  expect(f).toContain("age");
});

it("budgets nothing when paneWidth is absent (the full-width PRs view)", () => {
  const spec = prListColumns({ prs: worstPrs, showNwo: true });
  expect(spec.showChecks).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -12 /tmp/out`
Expected: exit 1 — the first new test fails because `checks` is still rendered (and `age` is clipped away), and `showChecks` does not exist.

- [ ] **Step 3: Add the budget**

In `src/tui/components/PrList.tsx`, replace the Task-1 builder's opts/result types and body with:

```tsx
/** Smallest title cell worth rendering. The title is the flexible column, so it
 * absorbs whatever the fixed cells leave; below this it stops being readable and
 * we would rather drop a fixed column than shave the title to nothing. */
const MIN_TITLE_W = 10;

export interface PrListColumnOpts {
  prs: DashPr[];
  showNwo: boolean;
  /** Outer width of the pane this list renders into — App passes
   * `layout.previewWidth` for the repo-scoped monitor. Undefined means no budget
   * pressure (the full-width PRs view), and every column always renders. */
  paneWidth?: number;
}

export interface PrListColumnSpec {
  columns: Column[];
  /** Inner pill width (badge text without the two pad spaces) — the Badge's `padTo`. */
  pillInner: number;
  repoW: number;
  checksW: number;
  /** False when the width budget dropped the checks column. */
  showChecks: boolean;
}

/** The single source of truth for this list's geometry: header cells and row
 * cells both read it, so they can never drift. Widths come from the CURRENT
 * dataset (or the header labels' own widths) — never from the selected row, so
 * moving the cursor can never shift a column.
 *
 * When `paneWidth` is given and the fixed cells cannot leave the title a
 * readable share, the CHECKS column drops. It is the only column whose signal
 * has another home: `derivePrState` folds checks-failing / checks-pending into
 * the lifecycle the state pill renders. Dropping it beats letting the row's
 * `overflow="hidden"` belt clip the trailing `age` cell away silently (#247). */
export function prListColumns({ prs, showNwo, paneWidth }: PrListColumnOpts): PrListColumnSpec {
  const badges = prs.map((p) => prStateMeta(derivePrState(p)).badge);
  const pillInner = Math.max("state".length, ...badges.map((b) => b.length), 0);
  const repoW = showNwo
    ? Math.min(NWO_MAX_WIDTH, Math.max("repo".length, ...prs.map((p) => p.nwo.length), 0))
    : 0;
  const checksW = Math.max("checks".length, ...prs.map((p) => checksToString(p.checks).length), 0);

  const build = (withChecks: boolean): Column[] => [
    { label: "", width: 1 },
    { label: "", width: 1 },
    { label: "#", width: 5, align: "right" },
    { label: "title", width: "flex" },
    ...(showNwo ? [{ label: "repo", width: repoW } as Column] : []),
    ...(withChecks ? [{ label: "checks", width: checksW } as Column] : []),
    { label: "state", width: pillInner + 2 },
    { label: "age", width: AGE_W, align: "right" },
  ];

  // Interior = pane width minus the round border (2) and paddingX (2). Every
  // adjacent pair costs one gap column (TableHeader and the rows both gap 1).
  const fits = (cols: Column[]): boolean => {
    if (paneWidth === undefined) return true;
    const fixed = cols.reduce((n, c) => n + (c.width === "flex" ? 0 : c.width), 0);
    return fixed + (cols.length - 1) + MIN_TITLE_W <= paneWidth - 4;
  };

  const withChecks = build(true);
  const showChecks = fits(withChecks);
  return { columns: showChecks ? withChecks : build(false), pillInner, repoW, checksW, showChecks };
}
```

In the component, thread the new prop and gate the row's checks cell:

```tsx
const { columns, pillInner, repoW, checksW, showChecks } = prListColumns({
  prs,
  showNwo,
  paneWidth,
});
```

Add `paneWidth?: number;` to `PrListProps` (with the doc comment "Outer pane width, for the column budget — see prListColumns.") and `paneWidth,` to the destructured parameter list. Then wrap the row's checks cell so it disappears with the column:

```tsx
{
  showChecks && (
    <Box flexShrink={0} width={checksW}>
      <Text color={checksColor}>{checksStr}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Pass the pane width from App**

In `src/tui/App.tsx`, the pane-3 monitor renders inside `<Box width={layout.previewWidth} height={listHeight}>`. Add one prop to that `<PrList …>` (leave the standalone `view === "prs"` PrList untouched — it is full width and must keep its checks column):

```tsx
                  paneWidth={layout.previewWidth}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/tuiPrColumns.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0.
Then the full suite → 0. Pane-3 assertions in `tests/tuiApp.test.tsx` that pin a checks string in the monitor will need retargeting: `grep -n "✓\|✗" tests/tuiApp.test.tsx | head` and fix only what actually breaks, keeping each test's intent.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/components/PrList.tsx src/tui/App.tsx tests/tuiPrColumns.test.tsx
git add src/tui/components/PrList.tsx src/tui/App.tsx tests/tuiPrColumns.test.tsx tests/tuiApp.test.tsx
git commit -m "fix(tui): drop the checks column before clipping age in a tight pane (#247)"
git log -1 --format=%B
```

---

### Task 3: Restore the `refreshedAt` behavior coverage (#249)

**Why:** Two behaviors of the refresh stamp — offline pull-back to the oldest cache age, and "a cycle that delivered nothing never advances the stamp" (`src/tui/App.tsx`'s `refreshAll`, the `delivered.length === 0` early return and the `oldest` loop) — lost their only tests when the header's `↻` chip was removed. The stamp now surfaces in the daemon panel's `refreshed` row, which gives both an observable surface again.

**Files:**

- Modify: `tests/tuiApp.test.tsx` — the `describe("unified refresh", …)` block (~line 2788) and the stale comment banner above it (~lines 2781-2786)

**Interfaces:**

- Consumes, all local to `tests/tuiApp.test.tsx` (do NOT reach for `tests/helpers/localFixtures.tsx` — that file exports a DIFFERENT `renderApp(over: Partial<AppProps>)`, and its `TO_DAEMON_ROW` is calibrated to its own two-repo fixture): this file's `renderApp(client, watchlistFile)` (line 351), the describe-local `twoRepoWl()` and `makeScopeClient()` (~lines 2789-2810), the file-level `makeClient`/`okv`/`rawIssue`, and `until` from `tests/helpers/until.ts`.
- Navigation: mirror the existing daemon test in this same describe — `for (const k of "jjjjj") r.stdin.write(k);` with `twoRepoWl()`, which walks acme/api → alx/coral → queue → outbox → worktrees → daemon. That 5-key count is tied to the TWO-repo watchlist; a single-repo `wl()` would overshoot the daemon row.

- [ ] **Step 1: Write the failing tests**

These are the two deleted tests, re-pointed from the header chip to the daemon panel. Add them to the `describe("unified refresh", …)` block, next to the existing daemon-panel stamp test:

```tsx
/** Walk the rail to the daemon system row: acme/api → alx/coral → queue →
 * outbox → worktrees → daemon (the twoRepoWl watchlist's row order). */
const toDaemonRow = (r: ReturnType<typeof renderApp>): void => {
  for (const k of "jjjjj") r.stdin.write(k);
};

it("offline: the daemon panel's stamp shows the OLDEST cache age, not the cycle time", async () => {
  const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
  const base = makeClient({ "acme/api": [rawIssue] }).client;
  const client: DashboardClient = {
    ...base,
    listIssues: async () => okv({ issues: [rawIssue], staleAt: null }),
    listPrs: async () => okv({ prs: [], staleAt: staleIso }), // cache-served
  };
  const r = renderApp(client, twoRepoWl());
  await until(() => (r.lastFrame() ?? "").includes("#7"));
  toDaemonRow(r);
  // 5m, not 0s: one source was served from cache, so the cycle is only as
  // fresh as its oldest input.
  await until(() => (r.lastFrame() ?? "").includes("↻ 5m ago"));
});

it("a cycle where nothing delivered never advances the stamp", async () => {
  const base = makeClient({ "acme/api": [rawIssue] }).client;
  let fail = false;
  const client: DashboardClient = {
    ...base,
    listIssues: async () =>
      fail
        ? ({ ok: false, error: "net down" } as const)
        : okv({ issues: [rawIssue], staleAt: null }),
    listPrs: async () =>
      fail ? ({ ok: false, error: "net down" } as const) : okv({ prs: [], staleAt: null }),
  };
  const r = renderApp(client, twoRepoWl());
  await until(() => (r.lastFrame() ?? "").includes("#7"));
  toDaemonRow(r);
  await until(() => (r.lastFrame() ?? "").includes("↻ 0s ago"));
  fail = true;
  r.stdin.write("r");
  await until(() => (r.lastFrame() ?? "").includes("net down")); // failure surfaced
  expect(r.lastFrame()).toContain("↻ 0s ago"); // stamp survives unchanged
});
```

Also fix the now-false comment banner above this describe (~lines 2781-2786). It still reads "The header's ↻ stamp UI is gone (declutter sweep) — refreshedAt bookkeeping continues internally for a future daemon panel, but has no visible surface to assert against here." The daemon panel landed; the surface exists and these tests use it. Rewrite the last clause to say the stamp is asserted through the daemon panel's `refreshed` row.

- [ ] **Step 2: Run to verify they fail for the RIGHT reason**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`

These tests assert behavior that is already implemented, so they may pass immediately — which proves nothing. Verify each one discriminates by temporarily breaking the implementation and watching it fail:

1. In `src/tui/App.tsx`'s `refreshAll`, temporarily replace `setRefreshedAt(oldest ?? new Date().toISOString());` with `setRefreshedAt(new Date().toISOString());` → the offline test must FAIL (`↻ 0s ago` instead of `↻ 5m ago`).
2. Restore it, then temporarily delete the `if (delivered.length === 0) return;` line → the second test must FAIL (the stamp advances on the failed cycle).
3. Restore the file exactly (`git diff src/tui/App.tsx` must be empty before you continue).

Record both failure messages in your report as the RED evidence.

- [ ] **Step 3: Run to verify they pass against the real implementation**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0, with `git diff src/tui/App.tsx` empty. Then the full suite → 0.

- [ ] **Step 4: Commit**

```bash
npx prettier --write tests/tuiApp.test.tsx
git add tests/tuiApp.test.tsx
git commit -m "test(tui): restore refreshedAt offline + no-delivery coverage (#249)"
git log -1 --format=%B
```

---

### Task 4: App-level breadcrumb and reserved-slot coverage (#250)

**Why:** `src/tui/App.tsx`'s `crumbs` memo maps eight view/body cases to breadcrumb arrays, but every existing test feeds `Header` a synthetic array — no test drives the App into a detail view and reads the header. Likewise the reserved third slot's local-repo arm (`ReservedNote`) has a component test but no App-level one; only the system-row `ActivityCard` arm is covered end to end.

**Files:**

- Test: `tests/tuiApp.test.tsx` (breadcrumbs) and `tests/tuiActivityCard.test.tsx` (reserved slot)

**Interfaces:**

- Breadcrumb tests live in `tests/tuiApp.test.tsx` and use THAT file's `renderApp(client, watchlistFile)` plus its file-level `makeClient`/`rawIssue`. Note `wl()` is describe-local (line ~396), so a new describe must define its own tmp-watchlist helper the same way: `const wlc = () => join(mkdtempSync(join(tmpdir(), "junco-crumb-")), "wl.json");`.
- The reserved-slot test lives in `tests/tuiActivityCard.test.tsx` and uses the OTHER `renderApp(over: Partial<AppProps>)` from `tests/helpers/localFixtures.tsx` (no args = 120 cols) with `tap` and `TO_QUEUE_ROW` (= `"jj"`), mirroring that file's existing "reserved third slot (App integration)" test.

- [ ] **Step 1: Write the failing breadcrumb test**

Add a new describe to `tests/tuiApp.test.tsx`, reusing that file's `makeClient`/`renderApp` helpers and its own watchlist helper:

```tsx
describe("header breadcrumbs", () => {
  const wlc = () => join(mkdtempSync(join(tmpdir(), "junco-crumb-")), "wl.json");

  it("shows the repo alone in the main view, then repo ▸ #N in the issue detail", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    expect(r.lastFrame()).toContain("acme/api");
    expect(r.lastFrame()).not.toContain("▸ #7");
    r.stdin.write("\r"); // enter on the rail row focuses the issues body
    r.stdin.write("\r"); // enter on the selected issue opens the detail
    await until(() => (r.lastFrame() ?? "").includes("acme/api ▸ #7"));
  });

  it("shows system ▸ <section> when a system row's body is open", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wlc());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    // ONE watched repo in this watchlist, so a single `j` lands on the queue row.
    r.stdin.write("j");
    await until(() => (r.lastFrame() ?? "").includes("system ▸ queue"));
  });
});
```

The `j`-count is watchlist-dependent: with `wlc()` (config repo `acme/api` only) the rail is one repo row then the five system rows. If the rail order surprises you, print `r.lastFrame()` once and count — do not copy a key sequence from another describe without checking its watchlist.

If the enter-key sequence in the first test does not reach the detail view in this fixture, mirror whichever navigation an existing detail-view test in the same file uses — the assertion (`acme/api ▸ #7` in the header) is the requirement, not the keystrokes.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -10 /tmp/out`
Expected: exit 1 if any crumb shape is wrong. If both pass immediately, verify they discriminate: temporarily change the `detail` branch of the `crumbs` memo in `src/tui/App.tsx` to `return [detail.nwo];` and confirm the first test fails, then restore (`git diff src/tui/App.tsx` empty).

- [ ] **Step 3: Write the reserved-slot test**

The third slot's local-repo arm renders `ReservedNote` when the selected rail row is a repo with no watched nwo (`body.kind === "repoDetail"`). The shared fixture's `configRepos` are both watched (`acme/api`, `beta/two`), so **first determine how a local-only row enters the rail**: read `src/tui/railModel.ts`'s repo-union sources and `tests/helpers/localFixtures.tsx`'s `CHEAP`/`HEAVY` shapes to see which field carries unwatched/local repos.

Then add to `tests/tuiActivityCard.test.tsx`, in its existing `describe("reserved third slot (App integration)", …)`:

```tsx
it("a local-only repo row reserves the third column with the local note", async () => {
  const r = renderApp({
    /* the override that adds ONE local-only repo row — the field you
         identified above; keep the two watched configRepos as they are */
  });
  await until(() => (r.lastFrame() ?? "").includes("system"));
  await tap(r, "j".repeat(N)); // N = rail steps to the local-only row; count from a printed frame
  await until(() => (r.lastFrame() ?? "").includes("local repo — no linked PRs"));
});
```

**If wiring a local-only row through the App fixture turns out to need more than a prop override** (e.g. it requires a real clones-dir scan), stop and do this instead — it tests the same invariant without the plumbing:

```tsx
it("the middle pane keeps its width across body kinds", async () => {
  const r = renderApp();
  await until(() => (r.lastFrame() ?? "").includes("issues"));
  const issuesFrame = r.lastFrame() ?? "";
  await tap(r, TO_QUEUE_ROW);
  await until(() => (r.lastFrame() ?? "").includes("activity"));
  const systemFrame = r.lastFrame() ?? "";
  // Every rendered line spans the full terminal in both frames — the reserved
  // slot means switching body kinds never reflows the middle pane.
  const widths = (f: string): number[] => f.split("\n").map((l) => l.length);
  expect(new Set(widths(issuesFrame))).toEqual(new Set(widths(systemFrame)));
});
```

Record in your report which of the two you used and why.

- [ ] **Step 4: Run both to verify they pass**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiActivityCard.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0. Then the full suite → 0 (adding a fixture repo row shifts rail navigation for other tests — retarget any `TO_*_ROW` arithmetic the suite surfaces, keeping intent).

- [ ] **Step 5: Commit**

```bash
npx prettier --write tests
git add tests
git commit -m "test(tui): App-level breadcrumb shapes and local-repo reserved slot (#250)"
git log -1 --format=%B
```

---

### Task 5: TUI cleanup sweep (#251)

**Why:** Seven small, independent nits collected across PR #246's task reviews. One commit, no behavior change intended except item 7 (which gives two panes back a row they were wrongly denied).

**Files:**

- Create: `src/tui/components/primitives/SectionStrip.tsx`
- Modify: `src/tui/components/IssueList.tsx`, `src/tui/components/PrList.tsx`, `src/tui/components/QueueView.tsx`, `src/tui/components/primitives/Rule.tsx`, `src/tui/components/sections.tsx`, `src/tui/components/RepoDetail.tsx`, `src/tui/components/HelpModal.tsx`, `src/tui/geometry.ts`, `src/tui/App.tsx`
- Test: `tests/tuiLocal.test.tsx`, `tests/tuiGeometry.test.ts`, `tests/tuiPrimitives.test.tsx`

**Interfaces:**

- Produces: `SectionStrip({ label, extra? })` from `src/tui/components/primitives/SectionStrip.js`; `DETAIL_RULE_WIDTH` from `src/tui/components/primitives/Rule.js`; `sectionRowsHeight(bodyRows: number): number` from `src/tui/geometry.js`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tuiPrimitives.test.tsx` (add the `SectionStrip` import):

```tsx
describe("SectionStrip", () => {
  it("renders the label and an optional dim extra on one row", () => {
    const { lastFrame } = render(
      <SectionStrip label="running" extra={<Text dimColor> (1/2)</Text>} />,
    );
    expect(lastFrame()).toBe("running (1/2)");
    expect((lastFrame() ?? "").split("\n")).toHaveLength(1);
  });

  it("renders the bare label with no extra", () => {
    const { lastFrame } = render(<SectionStrip label="recent" />);
    expect(lastFrame()).toBe("recent");
  });
});
```

Append to `tests/tuiGeometry.test.ts`:

```ts
it("sectionRowsHeight budgets a header-less body (borders + title + position)", () => {
  // The section bodies (outbox, worktrees) have no column-header strip, so they
  // get one row MORE than the issue/PR lists at the same terminal height.
  expect(sectionRowsHeight(20)).toBe(16);
  expect(listRowsHeight(20)).toBe(15);
  expect(sectionRowsHeight(2)).toBe(1); // clamped, never below 1
});
```

Replace the vacuous assertion in `tests/tuiLocal.test.tsx`'s `rate_limited gate with no reason` test (the line `expect(f).not.toContain("rate_limited —");` — the underscore form is never rendered post-restyle, so it can never fail). Assert the real requirement, that no dangling reason line follows the badge:

```tsx
expect(f).toContain("rate limited");
// No reason → no trailing reason line under the endpoint row. The badge is
// the last thing on its line and nothing follows it.
const endpointLine = f.split("\n").find((l) => l.includes("rate limited")) ?? "";
expect(endpointLine.replace(/[│─]/g, "").trim()).toMatch(/^endpoint\s+rate limited$/);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiPrimitives.test.tsx tests/tuiGeometry.test.ts tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -12 /tmp/out`
Expected: exit 1 — `SectionStrip` and `sectionRowsHeight` do not exist.

- [ ] **Step 3: Apply the seven fixes**

**3a — `SectionStrip` primitive.** Create `src/tui/components/primitives/SectionStrip.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";

/** One-row section band: a hover-tinted strip carrying a bold accent label plus
 * an optional dim extra (counts, a poll heartbeat). The narrative sibling of
 * TableHeader — same visual language, no columns. One row in, one row out, so
 * callers that window a flat row array keep their arithmetic. */
export function SectionStrip({
  label,
  extra,
}: {
  label: string;
  extra?: React.JSX.Element | null;
}): React.JSX.Element {
  return (
    <Box width="100%" backgroundColor={theme.hoverBg} overflow="hidden">
      <Text bold color={theme.accent}>
        {label}
      </Text>
      {extra ?? null}
    </Box>
  );
}
```

In `src/tui/components/QueueView.tsx`, delete the local `strip` helper and import the primitive; each call site becomes a `SectionStrip` element with the `key` moved onto it — for example the running header:

```tsx
rows.push(
  <SectionStrip
    key="run-h"
    label="running"
    extra={
      <Text dimColor>{` (${snap.running.length}/${snap.maxConcurrent})${
        pollAge !== null ? ` · ↻ poll ${pollAge}` : ""
      }`}</Text>
    }
  />,
);
```

and the three remaining ones:

```tsx
rows.push(
  <SectionStrip
    key="wait-h2"
    label="waiting"
    extra={<Text dimColor>{` (${waitSegs.join(" · ")})`}</Text>}
  />,
);
rows.push(<SectionStrip key="rec-h2" label="recent" />);
rows.push(<SectionStrip key="stats-t" label="stats" />);
```

**3b — IssueList row widths from `COLUMNS`.** In `src/tui/components/IssueList.tsx`, add named constants beside the existing `AGE_W`/`PILL_W` and use them in BOTH the `COLUMNS` array and the row cells, so the two can never drift:

```tsx
const GUTTER_W = 1;
const GLYPH_W = 1;
const NUM_W = 5;
```

`COLUMNS` becomes `{ label: "", width: GUTTER_W }, { label: "", width: GLYPH_W }, { label: "#", width: NUM_W, align: "right" }, …` and the three row cells become `width={GUTTER_W}`, `width={GLYPH_W}`, `width={NUM_W}` (the pill and age cells already read `PILL_W`/`AGE_W`).

**3c — `isBotAuthored` hoist.** In `src/tui/components/IssueList.tsx`, inside the row map above the returned JSX:

```tsx
const botAuthored = isBotAuthored(iss.author, botLogin);
```

then `color={botAuthored ? theme.accent : undefined}` and `dimColor={!sel && !botAuthored}`. Do the same in `src/tui/components/PrList.tsx` with `const botAuthored = isBotAuthored(prItem.author, botLogin);`.

**3d — Rule width convention.** In `src/tui/components/primitives/Rule.tsx`, export the shared constant:

```tsx
/** Rule width inside the fixed-layout detail panels (daemon, repo detail).
 * Those panels build a flat line array and never learn their own width, so they
 * share one deliberate constant; width-aware panes (the rail, the activity card)
 * compute `width - 4` from their own prop instead. */
export const DETAIL_RULE_WIDTH = 24;
```

Replace the four hardcoded `width={24}` usages — `src/tui/components/sections.tsx` (the `endpoint` and `activity` rules) and `src/tui/components/RepoDetail.tsx` (the `worktrees` and `recent tickets` rules) — with `width={DETAIL_RULE_WIDTH}`, importing it in both files.

**3e — HelpModal wording.** In `src/tui/components/HelpModal.tsx`, the `navigate` section's `enter` row still names pane numbers that no longer exist in the UI:

```tsx
          ["enter", "open detail — repo (rail), issue (list), PR (monitor / PRs view)"],
```

**3f — Section body height.** In `src/tui/geometry.ts`, add beside `listRowsHeight`:

```ts
/** Rows a header-less section body (outbox, worktrees) can show: borders(2) +
 * title(1) + position line(1). The issue/PR lists spend one more on their
 * column-header strip — see listRowsHeight. */
export function sectionRowsHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4);
}
```

In `src/tui/App.tsx`, the `sectionWin` computation (the `windowSlice` guarded by `sysSection !== null`) is the ONLY `listRowsHeight` call site that windows section bodies — switch that one call to `sectionRowsHeight(layout.bodyRows)` and add `sectionRowsHeight` to the `./geometry.js` import. Leave the issue, cross-repo PR, and pane-3 windows on `listRowsHeight`.

- [ ] **Step 4: Run to verify everything passes**

Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0. QueueView tests that pinned the old strip rendering and any section-window arithmetic pins will need retargeting — keep each test's intent, change only expectations. Then `npm run lint` → 0 and `npx tsc --noEmit -p tsconfig.eslint.json` (no NEW errors).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add src tests
git commit -m "refactor(tui): cleanup sweep — shared strip, column dedup, rule width, help wording (#251)"
git log -1 --format=%B
```

---

### Task 6: `StatRow` truncate-start option, adopted for RepoDetail's path (#252)

**Why:** Converting RepoDetail's key/value lines to `StatRow` changed how a long repo path elides: the old line kept the meaningful trailing segment (`…/repos/acme-api`), while `StatRow`'s `wrap="truncate-end"` cuts the tail and shows only the common prefix — the least discriminating part.

**Files:**

- Modify: `src/tui/components/primitives/StatRow.tsx`, `src/tui/components/RepoDetail.tsx:70`
- Test: `tests/tuiPrimitives.test.tsx`, `tests/tuiRepoDetail.test.tsx`

**Interfaces:**

- Produces: `StatRow` gains `truncate?: "end" | "start"` (default `"end"` — every existing call site keeps its behavior).

- [ ] **Step 1: Write the failing tests**

Append to `tests/tuiPrimitives.test.tsx`:

```tsx
describe("StatRow truncation", () => {
  it("defaults to truncating the value's end", () => {
    const { lastFrame } = render(
      <Box width={20}>
        <StatRow label="path" value="/home/alx/repos/acme-api" labelWidth={8} />
      </Box>,
    );
    expect(lastFrame()).toContain("/home/a"); // prefix survives
    expect(lastFrame()).not.toContain("acme-api");
  });

  it('truncate="start" keeps the discriminating tail', () => {
    const { lastFrame } = render(
      <Box width={20}>
        <StatRow label="path" value="/home/alx/repos/acme-api" labelWidth={8} truncate="start" />
      </Box>,
    );
    expect(lastFrame()).toContain("acme-api");
  });
});
```

Append to `tests/tuiRepoDetail.test.tsx` (mirror the file's existing render helper and fixture):

```tsx
it("keeps the repo directory visible when the path is too long for the pane", async () => {
  // A long common prefix with the discriminating segment last — end-truncation
  // would show only the prefix.
  const { lastFrame } = renderDetail({
    path: "/Users/alx/very/deeply/nested/workspace/repos/acme-api",
  });
  await until(() => (lastFrame() ?? "").includes("path"));
  expect(lastFrame()).toContain("acme-api");
});
```

If `tests/tuiRepoDetail.test.tsx` has no `renderDetail(overrides)` helper, build the fixture the same way its neighboring tests do (the `UnifiedRepo` literal plus a narrow `height`/wrapping `Box`); the requirement is that the rendered path shows `acme-api`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tuiPrimitives.test.tsx tests/tuiRepoDetail.test.tsx > /tmp/out 2>&1; echo "exit: $?"; tail -10 /tmp/out`
Expected: exit 1 — `truncate` is not a prop, and RepoDetail's path shows the prefix.

- [ ] **Step 3: Implement**

Replace `src/tui/components/primitives/StatRow.tsx`'s component (keep `statRowText` exactly as it is):

```tsx
/** Aligned key/value line for detail panels: dim fixed-width label, bold
 * value (optionally colored), dim hint suffix. One per stat — panels build
 * grids by stacking rows with one shared labelWidth. `truncate` picks which end
 * of an over-long line is sacrificed: "end" (default) for plain prose values,
 * "start" when the tail discriminates (a filesystem path's repo directory). */
export function StatRow({
  label,
  value,
  labelWidth,
  color,
  hint,
  truncate = "end",
}: {
  label: string;
  value: string;
  labelWidth: number;
  color?: string;
  hint?: string;
  truncate?: "end" | "start";
}): React.JSX.Element {
  return (
    <Text wrap={truncate === "start" ? "truncate-start" : "truncate-end"}>
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      <Text bold color={color}>
        {value}
      </Text>
      {hint !== undefined ? <Text dimColor> {hint}</Text> : null}
    </Text>
  );
}
```

In `src/tui/components/RepoDetail.tsx`, the path row becomes:

```tsx
lines.push(<StatRow key="p" label="path" value={repo.path} labelWidth={LW} truncate="start" />);
```

Note `truncate="start"` elides the label too when the line is extreme; that is acceptable for the path row (the value is what matters) and no other row opts in.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/tuiPrimitives.test.tsx tests/tuiRepoDetail.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0. Then the full suite → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/primitives/StatRow.tsx src/tui/components/RepoDetail.tsx tests
git add src tests
git commit -m "feat(tui): StatRow truncate-start, adopted for the repo path row (#252)"
git log -1 --format=%B
```

---

### Task 7: Correct the derived-keys table in `docs/dashboard.md` (#253)

**Why:** The table's "everywhere in the main view" row lists `v review` and `p PRs` among the keys, phrased so they read as always-visible footer chips. In `src/tui/viewActions.ts`, `review` appears in NO chip-order array and `prs` appears only in `ISSUES_CHIP_ORDER` — so neither renders as a chip on the rail or pane 3. Both keys do work everywhere (they are in the keymap and the help modal); only the doc's implication about the footer is wrong. This is pre-existing drift from the mnemonic-shortcuts PR, not from #246.

**Files:**

- Modify: `docs/dashboard.md` — the derived-keys table (the `everywhere in the main view` row) and the sentence introducing it

- [ ] **Step 1: Verify the claim against the code before writing**

Run: `grep -n "CHIP_ORDER" -A 12 src/tui/viewActions.ts`
Confirm: `RAIL_CHIP_ORDER` contains neither `review` nor `prs`; `ISSUES_CHIP_ORDER` contains `prs` but not `review`; `PANE3_CHIP_ORDER` contains neither. Record what you find — if the code has changed since this plan was written, document what is actually true rather than what this task assumed.

- [ ] **Step 2: Fix the table's framing**

The introductory sentence currently claims the footer always shows the live truth. Replace it and the affected row so the doc distinguishes _bound_ keys from _rendered_ chips:

```markdown
The derived keys, per context. Every key below works wherever its context is
active; the footer shows the pane-relevant subset (chip order lives in
`src/tui/viewActions.ts`), so a key can be live without a chip — `v` review is
keymap-only, and `p` PRs renders as a chip on the issues body alone. Press `?`
for the full per-view list.

| Context                     | Keys                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| everywhere in the main view | `a` add repo · `u` unwatch · `b` browser · `r` refresh · `s` assess (`A` auto-plan) · `e` queue · `v` review · `p` PRs · `c` commands · `q` quit · `?` help |
```

Leave every other row unchanged.

- [ ] **Step 3: Verify the docs build clean**

Run: `npm run format:check > /tmp/out 2>&1; echo "exit: $?"` → 0 (run `npx prettier --write docs/dashboard.md` first if it reformats the table).

- [ ] **Step 4: Commit**

```bash
git add docs/dashboard.md
git commit -m "docs(dashboard): distinguish bound keys from rendered chips (#253)"
git log -1 --format=%B
```

---

### Task 8: Full gate and PR

**Files:** none — verification and delivery only.

- [ ] **Step 1: Confirm one commit per issue**

Run: `git log --oneline origin/main..HEAD`
Expected: exactly 7 commits, each subject ending in `(#247)` … `(#253)`, in task order. No commit body contains an attribution trailer: `git log origin/main..HEAD --format=%B | grep -i "co-authored\|claude" ; echo "matches: $?"` → `matches: 1` (grep found nothing).

- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/tui-followups
gh pr create --base main --title "fix(tui): dashboard follow-ups (#247–#253)" --body "<summary + Closes lines>"
```

The body must contain a `Closes #247` … `Closes #253` line per issue so merging closes all seven, plus one short paragraph per commit describing what changed and why.

- [ ] **Step 4: Report the PR URL and CI status**

Run `gh pr checks <number>` once CI has started; report the URL and the check states.

---

## Corrections (written after execution)

Four things above were proven wrong while this plan was being executed. The
shipped code is correct; these notes exist so nobody re-derives the mistakes
from the task text, which is left unedited as the historical record.

**Task 3, Step 1 — the second test did not discriminate.** As written (walk to
the daemon row, then press `r`) it passes against broken code, for two
independent reasons. The refresh action only fires a network cycle when a repo
row is selected — `currentNwo` is unset once the body is a system section, so
`r` from the daemon row is a local-only no-op and `refreshAll` never runs. And
the daemon panel's relative-time anchor freezes at mount in this harness, so a
`↻ 0s ago` baseline still reads `0s` even when the stamp wrongly advances
(`relTimeShort` floors negative deltas at zero). Shipped fix (`623b707`): press
`r` while still on the issues row, and anchor the baseline five minutes in the
past so a wrongly-advanced stamp visibly diverges.

**Task 5, item 7 — the replacement assertion still could not fail.** The gate
reason renders as its OWN row (`<Text key="gate-r">` in `sections.tsx`), not
appended to the badge's line, so an assertion scoped to the line containing
`rate limited` can never see a dangling reason row. Shipped fix (`f086076`):
pin the row that FOLLOWS the endpoint row — `lines[iEndpoint + 1]` must contain
`health`.

**Task 6 — `truncate="start"` does not cleanly drop the label.** The plan called
the label loss acceptable. Measuring Ink showed something worse: `wrap` applies
to the whole flattened label+value string, so the label is the FIRST casualty
and renders as a fragment (`…th`, `…h`) in a band of roughly one to six
characters over budget, which also breaks column alignment with sibling rows.
Shipped fix (`46ac457`): a pinned `flexShrink={0}` label cell plus a
`flexGrow={1} minWidth={0}` value cell that carries the wrap — the pattern
already used in `IssueList`, `PrList`, `Chrome`, `UnifiedRail`, `ReviewView`,
and `TableHeader`. (The primitive still wraps to two lines if its container is
narrower than `labelWidth` — unreachable at any width this app supports.)

**Task 5, item 6 had a consequence the plan did not anticipate.** Widening the
section-body budget to `sectionRowsHeight` exposed a stale `height - 3` clip
inside `OutboxSection`, calibrated to the old budget, which then silently
dropped that pane's position line — the exact failure class this plan set out
to fix. Caught by the whole-branch review, not by any task-scoped one. Shipped
fix (`77ab3ca`): `height - 2`, derived from the pane's real interior, plus a
guard test proving the pane still cannot overflow.

**The rule that caught the first three:** a test asserting behavior that
already works proves nothing by passing. Every such test here had to be shown
failing first, by deliberately breaking the implementation it covers and
restoring it afterwards. Reviewers were also told not to defer to this plan's
judgment — the third correction came from a reviewer measuring Ink's actual
behavior instead of accepting the plan's claim about it.
