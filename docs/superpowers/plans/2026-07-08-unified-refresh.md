# Unified View-Scoped Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One 30s view-scoped refresh cycle driving both issues and PRs, with a single `↻ Xs` stamp in the dashboard's top bar replacing the per-pane stamps.

**Architecture:** App.tsx's two data intervals (issues 30s selected-repo, PRs 60s all-repos) collapse into one `refreshAll` cycle whose scope follows the view (main → selected repo's issues + PRs; monitor → all-repos PR sweep). Loaders return a `Delivery` outcome so the cycle can stamp `refreshedAt` with the oldest-cache-age-wins rule. The Header renders the stamp; the panes lose theirs. Spec: `docs/superpowers/specs/2026-07-08-unified-refresh-design.md`.

**Tech Stack:** React/Ink (ink 7), vitest 4 + ink-testing-library.

## Global Constraints

- Branch `feat/unified-refresh-stamp` (already on latest main). Conventional commits; **no AI attribution**; suite green at every commit; `npx prettier --write` on touched files before each commit; never pipe vitest through a filter.
- Ink/TUI tests: loop-until-condition (`until`), never fixed sleeps racing timers; sequence clients use the `advance()` latch pattern.
- `main` requires PR + green `quality-gate` — land via PR.
- The full local gate: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.

---

### Task 1: Loader `Delivery` outcomes, `loadPrsFor`, per-repo PR staleness

**Files:**
- Modify: `src/tui/App.tsx` (`loadIssues` ~421, `loadPrs` ~442, `prStaleAt` state ~206)
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**
- Produces: `type Delivery = { delivered: boolean; staleAt: string | null }` (module-level in App.tsx); `loadIssues(nwo): Promise<Delivery>`; `loadPrs(isAlive?): Promise<Delivery>` (all-repos sweep, full-replace semantics as today); `loadPrsFor(nwo, isAlive?): Promise<Delivery>` (replaces one repo's slice of the `prs` aggregate); `prStaleByRepo: Record<string, string | null>` state with derived `prStaleAt` (oldest non-null among watched).

- [ ] **Step 1: Write the failing test** (in `tests/tuiApp.test.tsx`, a client with two watched repos where a scoped refresh of repo A must not drop repo B's PRs — drive it via the `r` key after Task 2; for now assert current behavior still passes by running the file). This task is internal plumbing: its test cycle is "suite stays green" plus the Task 2 tests that consume the new signatures. Proceed to implementation.

- [ ] **Step 2: Add the `Delivery` type and rework `loadIssues`**

Module level (near the other type aliases in App.tsx):

```ts
/** What a loader actually delivered — the unified cycle aggregates these to
 * stamp refreshedAt (oldest cache staleAt wins; nothing delivered → no stamp). */
type Delivery = { delivered: boolean; staleAt: string | null };
```

`loadIssues` returns it and loses the `setIssuesFetchedAt` site (state deleted in Task 2):

```ts
  const loadIssues = useCallback(
    (nwo: string): Promise<Delivery> => {
      return client.listIssues(nwo).then((res) => {
        if (res.ok) {
          setIssues((prev) => ({ ...prev, [nwo]: sortIssues(res.value.issues, trigger) }));
          setStaleAt((prev) => ({ ...prev, [nwo]: res.value.staleAt }));
          return { delivered: true, staleAt: res.value.staleAt };
        }
        showToast("error", res.error);
        return { delivered: false, staleAt: null };
      });
    },
    [client, trigger, showToast],
  );
```

- [ ] **Step 3: Per-repo PR staleness + scoped fetch**

Replace `const [prStaleAt, setPrStaleAt] = useState<string | null>(null);` with:

```ts
  // Per-repo staleness so a SCOPED refresh clears only its own repo's marker;
  // the list-level marker derives as the oldest non-null among watched repos.
  const [prStaleByRepo, setPrStaleByRepo] = useState<Record<string, string | null>>({});
  const prStaleAt = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    let oldest: string | null = null;
    for (const [nwo, s] of Object.entries(prStaleByRepo)) {
      if (!watched.has(nwo) || s === null) continue;
      if (oldest === null || Date.parse(s) < Date.parse(oldest)) oldest = s;
    }
    return oldest;
  }, [prStaleByRepo, repoMappings]);
```

Rework `loadPrs` (keep full-replace-of-successes semantics and the "one repo down never blocks the rest" comment; drop the `setPrsFetchedAt` site):

```ts
  const loadPrs = useCallback(
    (isAlive: () => boolean = () => true): Promise<Delivery> => {
      const targets = repoMappings.map((r) => r.nwo);
      return Promise.all(targets.map((nwo) => client.listPrs(nwo))).then((results) => {
        if (!isAlive()) return { delivered: false, staleAt: null };
        const all: DashPr[] = [];
        const staleMap: Record<string, string | null> = {};
        let oldest: string | null = null;
        let delivered = false;
        results.forEach((res, i) => {
          if (!res.ok) return; // one repo down: skip it, never block the rest
          delivered = true;
          all.push(...res.value.prs);
          staleMap[targets[i]] = res.value.staleAt;
          const s = res.value.staleAt;
          if (s !== null && (oldest === null || Date.parse(s) < Date.parse(oldest))) oldest = s;
        });
        setPrs(sortPrs(all));
        setPrStaleByRepo(staleMap);
        return { delivered, staleAt: oldest };
      });
    },
    [client, repoMappings],
  );
```

Add the scoped sibling directly below:

```ts
  // Scoped sibling of loadPrs: refresh ONE repo's slice of the cross-repo
  // aggregate — main-view cycles poll only the selected repo.
  const loadPrsFor = useCallback(
    (nwo: string, isAlive: () => boolean = () => true): Promise<Delivery> => {
      return client.listPrs(nwo).then((res) => {
        if (!isAlive() || !res.ok) return { delivered: false, staleAt: null };
        setPrs((prev) => sortPrs([...prev.filter((p) => p.nwo !== nwo), ...res.value.prs]));
        setPrStaleByRepo((prev) => ({ ...prev, [nwo]: res.value.staleAt }));
        return { delivered: true, staleAt: res.value.staleAt };
      });
    },
    [client],
  );
```

- [ ] **Step 4: Suite still green**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiPrList.test.tsx > /tmp/t1.out 2>&1; echo "exit: $?"` → `exit: 0`. (Typecheck will fail until Task 2 removes the `prsFetchedAt`/`issuesFetchedAt` consumers — that is expected mid-flight; do NOT commit yet. Tasks 1+2 commit together.)

---

### Task 2: `refreshAll`, unified interval, immediate cycles, stamp state

**Files:**
- Modify: `src/tui/App.tsx` (props ~56-58 & ~173-176, state ~196-198, effects ~470 & ~529-586, `p` handler ~1127, `r` handlers ~1054 & ~1173, pane props ~1446/1461/1485)
- Test: `tests/tuiApp.test.tsx` (`renderApp` helper + new cycle tests)

**Interfaces:**
- Consumes: `Delivery`, `loadIssues`, `loadPrs`, `loadPrsFor` (Task 1).
- Produces: App prop `refreshPollMs?: number` (default 30_000; `issuePollMs`/`prPollMs` deleted); state `refreshedAt: string | null` (Task 3's Header consumes it); `refreshAll(opts?: { isAlive?: () => boolean; scope?: "main" | "monitor" }): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (append to `tests/tuiApp.test.tsx`; `renderApp` is updated in Step 2 — write these against the NEW 3rd-positional `refreshPollMs`):

```tsx
describe("unified refresh", () => {
  const twoRepoWl = () => {
    const p = join(mkdtempSync(join(tmpdir(), "junco-app-")), "wl.json");
    writeFileSync(p, JSON.stringify({ repos: [{ nwo: "acme/api" }, { nwo: "alx/coral" }] }));
    return p;
  };
  // A client that records every listIssues/listPrs call's nwo.
  function makeScopeClient() {
    const issueCalls: string[] = [];
    const prCalls: string[] = [];
    const base = makeClient({ "acme/api": [rawIssue], "alx/coral": [] }).client;
    const client: DashboardClient = {
      ...base,
      listIssues: async (nwo) => {
        issueCalls.push(nwo);
        return okv({ issues: [rawIssue], staleAt: null });
      },
      listPrs: async (nwo) => {
        prCalls.push(nwo);
        return okv({ prs: [makePr({ nwo })], staleAt: null });
      },
    };
    return { client, issueCalls, prCalls };
  }

  it("r in the main view refreshes ONLY the selected repo (issues + PRs)", async () => {
    const { client, issueCalls, prCalls } = makeScopeClient();
    const r = renderApp(client, twoRepoWl()); // refreshPollMs default: huge in tests
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    const i0 = issueCalls.length;
    const p0 = prCalls.length;
    r.stdin.write("r");
    await until(() => issueCalls.length > i0 && prCalls.length > p0);
    expect(issueCalls.slice(i0)).toEqual(["acme/api"]);
    expect(prCalls.slice(p0)).toEqual(["acme/api"]); // NOT alx/coral
  });

  it("entering the PR monitor sweeps every watched repo", async () => {
    const { client, prCalls } = makeScopeClient();
    const r = renderApp(client, twoRepoWl());
    await until(() => (r.lastFrame() ?? "").includes("#7"));
    const p0 = prCalls.length;
    r.stdin.write("p");
    await until(() => prCalls.length >= p0 + 2);
    expect(prCalls.slice(p0).sort()).toEqual(["acme/api", "alx/coral"]);
  });

  it("stamps ↻ in the header after a cycle; offline cache age wins", async () => {
    const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const base = makeClient({ "acme/api": [rawIssue] }).client;
    const client: DashboardClient = {
      ...base,
      listIssues: async () => okv({ issues: [rawIssue], staleAt: null }),
      listPrs: async () => okv({ prs: [], staleAt: staleIso }), // cache-served
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("↻ 5m"));
  });

  it("a cycle where nothing delivered never advances the stamp", async () => {
    const base = makeClient({ "acme/api": [rawIssue] }).client;
    let fail = false;
    const client: DashboardClient = {
      ...base,
      listIssues: async () =>
        fail ? { ok: false as const, error: "net down" } : okv({ issues: [rawIssue], staleAt: null }),
      listPrs: async () =>
        fail ? { ok: false as const, error: "net down" } : okv({ prs: [], staleAt: null }),
    };
    const r = renderApp(client, wl());
    await until(() => (r.lastFrame() ?? "").includes("↻ 0s"));
    fail = true;
    r.stdin.write("r");
    await tick();
    expect(r.lastFrame()).toContain("↻"); // stamp survives, does not vanish or reset
  });
});
```

(Adjust fixture names to the file's existing `makeClient`/`okv`/`rawIssue`/`makePr`/`wl` helpers — they all already exist. If `makeClient`'s two-arg form differs, build the base client the way the file's other multi-repo tests do.)

- [ ] **Step 2: Implement in App.tsx**

1. Props: delete `issuePollMs?`/`prPollMs?` (lines ~56-58) and their defaults (~173-176); add `refreshPollMs?: number` with `const refreshPollMs = props.refreshPollMs ?? 30_000;`.
2. State: delete `issuesFetchedAt`/`prsFetchedAt` (+ set sites at ~428, ~463, and the manual-refresh site ~807); add `const [refreshedAt, setRefreshedAt] = useState<string | null>(null);`.
3. Add `viewRef` beside `nwoRef` and the cycle:

```ts
  const viewRef = useRef(view);
  viewRef.current = view;
  // The ONE refresh cycle. Scope follows the view unless overridden (the `p`
  // handler must sweep before the "prs" view state has committed): main →
  // selected repo's issues + PRs; monitor → every watched repo's PRs.
  const refreshAll = useCallback(
    (opts: { isAlive?: () => boolean; scope?: "main" | "monitor" } = {}): Promise<void> => {
      const isAlive = opts.isAlive ?? (() => true);
      const inMonitor =
        opts.scope !== undefined
          ? opts.scope === "monitor"
          : viewRef.current === "prs" || viewRef.current === "prDetail";
      const nwo = nwoRef.current;
      const jobs: Promise<Delivery>[] = inMonitor
        ? [loadPrs(isAlive)]
        : nwo
          ? [loadIssues(nwo), loadPrsFor(nwo, isAlive)]
          : [];
      if (jobs.length === 0) return Promise.resolve();
      return Promise.all(jobs).then((outcomes) => {
        if (!isAlive()) return;
        const delivered = outcomes.filter((o) => o.delivered);
        if (delivered.length === 0) return; // nothing arrived: never advance
        let oldest: string | null = null;
        for (const o of delivered) {
          const s = o.staleAt;
          if (s !== null && (oldest === null || Date.parse(s) < Date.parse(oldest))) oldest = s;
        }
        setRefreshedAt(oldest ?? new Date().toISOString());
      });
    },
    [loadIssues, loadPrs, loadPrsFor],
  );
```

4. Effects: delete the issue-poll interval effect (~529-538) and the cross-repo PR poll effect (~576-586). Replace the selection effect (~470, `useEffect([currentNwo]) → loadIssues`) body with `void refreshAll();`. Add:

```ts
  // The unified poll — one interval, view-scoped. Immediate cycles fire from
  // the selection effect, the `p` handler, and `r`.
  useEffect(() => {
    let alive = true;
    const id = setInterval(() => void refreshAll({ isAlive: () => alive }), refreshPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshAll, refreshPollMs]);

  // Full sweep on mount and whenever the watchlist changes: populates the ⚑
  // attention chip and the monitor aggregate (a newly-watched repo's PRs
  // appear without waiting for a monitor visit). Scoped cycles take over
  // between watchlist changes.
  useEffect(() => {
    let alive = true;
    void refreshAll({ isAlive: () => alive, scope: "monitor" });
    return () => {
      alive = false;
    };
  }, [refreshAll]);
```

5. `p` handler (~1127): after `setView("prs");` add `void refreshAll({ scope: "monitor" });` (the override — `viewRef` still reads "main" until the next render commits).
6. `r` handlers: PRs view (~1054) `if (input === "r") return void refreshAll();` (viewRef already reads "prs" there); main view (~1173) keep the spinner:

```ts
    if (input === "r") {
      setRefreshing(true);
      void refreshAll().finally(() => setRefreshing(false));
      return;
    }
```

7. Pane props: remove `fetchedAt={...}` at ~1446/1461/1485 (Task 4 removes the prop from the components; until then TS still accepts it — remove now, panes render without stamps once Task 4 lands; mid-flight the panes still typecheck because the prop is optional? It is NOT optional — so Tasks 2 and 4's App/pane edits must land in the same commit batch. Run typecheck only after Task 4's component edits.)
8. Wire `refreshedAt={refreshedAt}` into the `<Header ...>` render (prop exists after Task 3).

- [ ] **Step 3: Update `renderApp`** in `tests/tuiApp.test.tsx`: signature becomes `(client, watchlistFile, refreshPollMs = 999999, runCliFn?, queueFn?, ...)` — delete the trailing `prPollMs` param, pass `refreshPollMs={refreshPollMs}` to `<App>`, delete `issuePollMs`/`prPollMs`. Update the two callers that passed poll values: the issues-anchor test (`renderApp(client, wl(), 60)` — unchanged position) and the PR-anchor test (`renderApp(client, wlp(), 999999, undefined, undefined, 60)` → `renderApp(client, wlp(), 60)`). The PR-anchor test's poll now also fetches issues — its `makePrSeqClient` already stubs `listIssues` to return `[]`, fine.

- [ ] **Step 4: Delete the obsolete pane-stamp App tests** — any `tuiApp` test asserting `↻` inside a PANE title (grep `↻` in the file; keep the new header-stamp tests).

- [ ] **Step 5: Run the App suite** (typecheck deferred to Task 4): `npx vitest run tests/tuiApp.test.tsx > /tmp/t2.out 2>&1; echo "exit: $?"` → `exit: 0`.

---

### Task 3: Header `↻` chip

**Files:**
- Modify: `src/tui/components/Chrome.tsx` (Header props + right chip group ~96-129)
- Test: `tests/tuiChrome.test.tsx`

**Interfaces:**
- Consumes: `relTimeShort` (exported from `./IssueList.js` — Chrome already imports `relTime` from there).
- Produces: `refreshedAt: string | null` prop on `Header`.

- [ ] **Step 1: Write the failing tests** (match `tuiChrome.test.tsx`'s existing Header render helper/props):

```tsx
it("renders the unified ↻ refresh stamp from refreshedAt", () => {
  // render Header with refreshedAt 12s before `now` → expect "↻ 12s"
});
it("hides the ↻ stamp before the first cycle (refreshedAt null)", () => {
  // render with refreshedAt: null → expect no "↻"
});
it("keeps the ↻ stamp in narrow mode", () => {
  // mode: "narrow" (or the file's non-wide fixture) → still contains "↻"
});
```

(Write them concretely against the file's existing Header test scaffolding — every Header test in that file already builds the full prop set; copy one and set `refreshedAt`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiChrome.test.tsx` → FAIL (unknown prop / missing ↻).

- [ ] **Step 3: Implement** — add to Header props:

```tsx
  /** Last completed unified refresh cycle (oldest cache age when any source
   * was served offline) — the top bar's single ↻ stamp. Null until the first
   * cycle completes. */
  refreshedAt: string | null;
```

and in the right chip group, after the daemon chip (present in ALL modes — it is the point of the feature):

```tsx
        {refreshedAt !== null && <Text dimColor>↻ {relTimeShort(refreshedAt, now)}</Text>}
```

with `relTimeShort` added to the existing `./IssueList.js` import.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/tuiChrome.test.tsx` → PASS. (Other Header call sites: App.tsx gains `refreshedAt={refreshedAt}` — done in Task 2 step 8; any other test rendering Header directly needs the new prop added — the run will name them.)

---

### Task 4: Remove the per-pane stamps

**Files:**
- Modify: `src/tui/components/IssueList.tsx` (prop ~37-40, stamp render ~83-84), `src/tui/components/PrList.tsx` (prop ~33-35, stamp render ~68-69)
- Test: `tests/tuiIssueList.test.tsx`, `tests/tuiPrList.test.tsx`

- [ ] **Step 1: Remove `fetchedAt` prop + the `↻` title render from both components.** In each, the render is `{(staleAt ?? fetchedAt) !== null && (<Text dimColor> ↻ …</Text>)}` — delete the whole expression (the separate `offline · HH:MM` badge keyed on `staleAt` elsewhere in the title stays). Keep `relTimeShort` exported from IssueList (Chrome now consumes it).
- [ ] **Step 2: Update the two components' tests** — delete the "freshness stamp" describes (they assert pane-title `↻`); remove `fetchedAt` from every fixture render in both files (the run will name each).
- [ ] **Step 3: Full typecheck + suite now green end-to-end**

Run: `npm run typecheck; echo "tc: $?"` → `tc: 0`, then `npx vitest run > /tmp/t4.out 2>&1; echo "exit: $?"` → `exit: 0`.

- [ ] **Step 4: Commit Tasks 1–4 as one coherent change**

```bash
npx prettier --write src/tui/App.tsx src/tui/components/Chrome.tsx src/tui/components/IssueList.tsx src/tui/components/PrList.tsx tests/tuiApp.test.tsx tests/tuiChrome.test.tsx tests/tuiIssueList.test.tsx tests/tuiPrList.test.tsx
git add src/tui tests/
git commit -m "feat(tui): unified view-scoped refresh cycle with a single top-bar ↻ stamp"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 5: Docs, full gate, PR

**Files:**
- Modify: `docs/dashboard.md`, `docs/github-mode.md` (per-pane stamp text → top-bar chip + scoped polling)

- [ ] **Step 1: Update the docs.** `grep -rn "↻" docs/*.md` — rewrite each hit: the stamp now lives in the header and reads "time since the last refresh of what you're looking at"; main view polls the selected repo's issues + PRs every 30s; the `p` PR monitor polls every watched repo's junco-authored PRs; `r` refreshes the current view's scope; offline cache age still wins. Delete claims of separate 30s/60s cadences.
- [ ] **Step 2: Full gate**

Run each with captured exit codes (no piping): `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, `npx vitest run`. Expected: all 0.

- [ ] **Step 3: Commit + PR**

```bash
git add docs/
git commit -m "docs(dashboard): unified refresh stamp + view-scoped polling"
git push -u origin feat/unified-refresh-stamp
gh pr create --title "feat(tui): unified view-scoped refresh with single top-bar stamp" --body "..."
gh pr checks --watch
```

PR body: one paragraph on the cycle scoping (main = selected repo only, monitor = sweep, junco-authored PRs only), one on the stamp semantics (oldest-cache-age wins, nothing-delivered never advances), one line noting per-pane stamps removed. Merge on green (established pattern).

---

## Self-review notes

- Spec coverage: cycle scoping (T2 refreshAll + p/r/selection wiring), stamp semantics incl. offline + nothing-delivered (T2), per-repo PR merge + staleness map (T1), Header chip both modes (T3), pane stamp removal + `offline` badge preserved (T4), startup/watch-change sweep (T2 effect), docs (T5).
- Sequencing honesty: `fetchedAt` is a required pane prop, so Tasks 1–4 form one commit; intermediate verification uses per-file vitest runs, full typecheck lands at Task 4 Step 3.
- Type consistency: `Delivery` produced in T1, consumed by T2's `refreshAll`; `refreshedAt: string | null` produced in T2, consumed by T3's Header prop; `refreshAll(opts?: { isAlive?; scope? })` used identically in the interval, sweep effect, selection effect, and `p`/`r` handlers.
