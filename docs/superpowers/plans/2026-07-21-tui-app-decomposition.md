# TUI App Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `src/tui/App.tsx`'s ~121 hooks into coherent, independently-testable custom hooks under `src/tui/hooks/`, keeping the nav spine and composition layer in `App`, then a committed `React.memo` pass — all behavior-preserving.

**Architecture:** Three tiers — leaf hooks (isolated state) → `useWatchlist` → the fused `useGithubData` core — plus a `React.memo` pass. The nav spine (`view`/`pane`/`railSel` + derived) stays in `App` and is passed _into_ the hooks as read-only focus context. The 189 black-box TUI tests are the invariant safety net; each new hook additionally gets a `Probe`-component unit test.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), React + Ink, vitest, ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-21-tui-app-decomposition-design.md`
**Map:** the state/effect/coupling inventory in the design's provenance (domains A–P, effect table, coupling graph).

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TypeScript. Imports use `.js` extensions.
- Dependencies exact-pinned (`npm install --save-exact`); this task adds none.
- **No AI attribution in commits.** Amend away any subagent-appended trailer.
- Conventional commits (`refactor:`, `test:`, `perf:`, `docs:`), suite green at **every** commit.
- **The 189 black-box TUI tests must stay green at every commit** — they are the behavior invariant. Full run before every commit: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- **Exit-code trap:** never pipe vitest into grep/tail for the exit code — redirect, then `echo $?`.
- **Ink test gotcha:** never assert one fixed `setTimeout` tick after a state change — use `tests/helpers/until.ts`'s `until()`/`fireUntil` (loop-until-condition). The `tap` helper in `localFixtures.tsx` writes one key per 5ms tick.
- Prettier may reformat between read and edit — re-read before editing; `npx prettier --write` touched files before committing.
- **Live runtime:** the daemon renders this TUI from the main checkout. Do not run `junco start`. Green-at-every-commit is the guard.
- **`logReaderDeps` must stay `undefined` in production** so `useLogTail`'s effect dep identity is stable (App.tsx:123–126). Preserve exactly in `useLogOverlay`.
- New hooks live in `src/tui/hooks/`. Existing `src/tui/use*.ts` (Scroll, LogTail, TerminalSize, GuardedInput, Suspend) are shared mechanics — do NOT move them.

---

## Task 0: Baseline — render-count instrumentation + suite state

**Files:**

- Create: `src/tui/renderCount.ts`
- Create: `tests/renderCount.test.tsx`

**Interfaces:**

- Produces: `bumpRender(name: string): void`, `renderCounts(): Record<string, number>`, `resetRenderCounts(): void` — a module-level counter enabled only when `process.env.JUNCO_RENDER_COUNT === "1"`.

This is the measurement seam for the perf pass (Task 16). A component calls `bumpRender("IssueList")` in its body; the counter is a no-op unless the env flag is set, so production and normal tests are unaffected.

- [ ] **Step 1: Write the failing test**

`tests/renderCount.test.tsx`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { bumpRender, renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";

describe("renderCount", () => {
  beforeEach(() => resetRenderCounts());

  it("is a no-op unless the env flag is set", () => {
    delete process.env.JUNCO_RENDER_COUNT;
    bumpRender("X");
    expect(renderCounts()).toEqual({});
  });

  it("counts per name when enabled", () => {
    process.env.JUNCO_RENDER_COUNT = "1";
    bumpRender("A");
    bumpRender("A");
    bumpRender("B");
    expect(renderCounts()).toEqual({ A: 2, B: 1 });
    delete process.env.JUNCO_RENDER_COUNT;
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/renderCount.test.tsx > /tmp/rc.txt 2>&1; echo "exit: $?"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/tui/renderCount.ts`:

```ts
/**
 * Test-only render counter for the App-decomposition perf pass. A no-op unless
 * JUNCO_RENDER_COUNT=1, so production and ordinary tests pay nothing. Big leaf
 * components call bumpRender(name) in their body; the memo pass (perf task) is
 * measured by driving a poll and comparing counts before/after.
 */
const counts: Record<string, number> = {};

export function bumpRender(name: string): void {
  if (process.env.JUNCO_RENDER_COUNT !== "1") return;
  counts[name] = (counts[name] ?? 0) + 1;
}

export function renderCounts(): Record<string, number> {
  return { ...counts };
}

export function resetRenderCounts(): void {
  for (const k of Object.keys(counts)) delete counts[k];
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run tests/renderCount.test.tsx > /tmp/rc.txt 2>&1; echo "exit: $?"
```

Expected: exit 0.

- [ ] **Step 5: Capture the pre-refactor baseline count**

Add `bumpRender("App")` as the first line of `App`'s body (App.tsx, right after the `props` destructure at ~line 268). Then measure:

```bash
cat > /tmp/measure.test.tsx <<'EOF'
import { describe, it } from "vitest";
import { renderApp, HEAVY, tap } from "./helpers/localFixtures.js";
import { renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";
describe("baseline", () => {
  it("counts App renders over a fixed sequence", async () => {
    process.env.JUNCO_RENDER_COUNT = "1";
    resetRenderCounts();
    const r = renderApp();
    await tap(r.stdin, "j"); await tap(r.stdin, "k"); await tap(r.stdin, "j");
    console.log("BASELINE renderCounts:", JSON.stringify(renderCounts()));
    r.unmount();
    delete process.env.JUNCO_RENDER_COUNT;
  });
});
EOF
cp /tmp/measure.test.tsx tests/_measure.test.tsx
npx vitest run tests/_measure.test.tsx > /tmp/base.txt 2>&1; grep "BASELINE renderCounts" /tmp/base.txt
rm tests/_measure.test.tsx
```

Record the printed `App` count in the commit body — this is the pre-refactor baseline. (Leave the `bumpRender("App")` line in; Task 16 re-uses it. Big-component counters are added in Task 16.)

- [ ] **Step 6: Full suite green, then commit**

```bash
npx vitest run > /tmp/all.txt 2>&1; echo "exit: $?"; grep -E "Test Files|Tests " /tmp/all.txt
```

Expected: exit 0, all passing (baseline count 3149 + the new renderCount test).

```bash
git add src/tui/renderCount.ts tests/renderCount.test.tsx src/tui/App.tsx
git commit -m "test(tui): add a render-count seam and capture the App baseline"
```

---

## The leaf-hook procedure (Tasks 1–12)

Every leaf hook follows the **identical** procedure below. It is stated once in full; each task lists only its specifics (file, state moved, signature, unit-test assertions).

**Per-hook procedure:**

1. **Write the hook's Probe unit test first** (TDD), in `tests/<hookName>.test.tsx`, following `tests/useLogTail.test.tsx`'s pattern: a tiny `Probe` component calls the hook and renders its state/actions as text; drive it with `ink-testing-library`'s `render`/`rerender` and `stdin`; assert on `lastFrame()`. Run it, confirm it FAILS (module not found).
2. **Create the hook** in `src/tui/hooks/<hookName>.ts` (or `.tsx` if it renders/returns JSX-touching values). Move the exact state declarations, callbacks, and effects from `App.tsx` verbatim — do not rewrite logic. Export a typed return object.
3. **Run the unit test** — confirm it passes.
4. **Wire it into `App`**: replace the moved declarations with `const { … } = useXxx(…);`, delete the now-dead lines, add the import. Keep every consumer reference identical (same variable names via destructuring).
5. **Full suite green** (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`) — the 189 black-box tests prove behavior is preserved.
6. **`npx prettier --write`** the touched files; `npx eslint` them.
7. **Commit** (`refactor(tui): extract useXxx from App`).

**Verification after each:** the full-suite test COUNT rises by the hook's unit tests and never falls (no black-box test may be deleted or change).

### Task 1: `useToast`

**Files:** Create `src/tui/hooks/useToast.ts`, `tests/useToast.test.tsx`. Modify `src/tui/App.tsx`.

**Interfaces:**

- Produces: `useToast(): { toast: { kind: ToastKind; text: string } | null; showToast: (kind: ToastKind, text: string) => void; dismissToast: () => void }`

Extract first — `showToast` is consumed by nearly every later hook. Moves App lines 321 (`toast`), 322 (`toastTimer`), 557–561 (`showToast`), 562–567 (cleanup effect), 1552–end (`dismissToast`).

- [ ] **Step 1: Probe unit test** `tests/useToast.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useToast } from "../src/tui/hooks/useToast.js";

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  onReady(api);
  return <Text>{api.toast ? `${api.toast.kind}:${api.toast.text}` : "none"}</Text>;
}

describe("useToast", () => {
  it("shows then the state reflects it, and dismiss clears", async () => {
    let api!: ReturnType<typeof useToast>;
    const r = render(<Probe onReady={(a) => (api = a)} />);
    expect(r.lastFrame()).toBe("none");
    api.showToast("info", "hi");
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("info:hi");
    api.dismissToast();
    await new Promise((res) => setTimeout(res, 5));
    expect(r.lastFrame()).toBe("none");
    r.unmount();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/useToast.test.tsx > /tmp/t.txt 2>&1; echo "exit: $?"`).

- [ ] **Step 3: Create `src/tui/hooks/useToast.ts`:**

```ts
import { useState, useRef, useCallback, useEffect } from "react";
import type { ToastKind } from "../theme.js"; // ToastKind's real import — verify the source path in App.tsx's imports

export interface Toast {
  kind: ToastKind;
  text: string;
}

export function useToast(): {
  toast: Toast | null;
  showToast: (kind: ToastKind, text: string) => void;
  dismissToast: () => void;
} {
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: ToastKind, text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  return { toast, showToast, dismissToast };
}
```

Note: verify `ToastKind`'s real import path from App.tsx's import block before writing; the current `dismissToast` in App has a `if (!toast) return;` guard that is unnecessary once `setToast(null)` is idempotent — drop it, but confirm no caller relied on the early return (grep `dismissToast` usages).

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire into App** — replace lines 321–322 and 557–567 with `const { toast, showToast, dismissToast } = useToast();` near the top of App's body (before first use), delete the old `dismissToast` (1552) and the cleanup effect (562), add the import. `toast`/`showToast`/`dismissToast` references elsewhere are unchanged.

- [ ] **Step 6: Full suite green.** `npx vitest run > /tmp/all.txt 2>&1; echo "exit: $?"`

- [ ] **Step 7: prettier + eslint + commit** `refactor(tui): extract useToast from App`.

### Task 2: `useConfirm`

**Files:** Create `src/tui/hooks/useConfirm.ts`, `tests/useConfirm.test.tsx`. Modify App.

**Interfaces:** `useConfirm(): { confirm: ConfirmState | null; askConfirm: (s: ConfirmState) => void; clearConfirm: () => void }`. Export the `ConfirmState` interface from the hook (currently declared in App.tsx:154) and import it back into App.

Moves App lines 359 (`confirm`), 1229 (`askConfirm`). `clearConfirm = () => setConfirm(null)` replaces the inline `setConfirm(null)` calls in the input handler (they become `clearConfirm()`).

Follow the leaf procedure. Probe test: `askConfirm({title, body, danger, onConfirm})` → state reflects it; `clearConfirm()` → null. Commit `refactor(tui): extract useConfirm from App`.

### Task 3: `useHealth`

**Files:** Create `src/tui/hooks/useHealth.ts`, `tests/useHealth.test.tsx`. Modify App.

**Interfaces:** `useHealth(client: DashboardClient, pollMs: number): HealthInfo | null`. Moves App lines 323 + effect 921–933 verbatim.

Hook body:

```ts
import { useState, useEffect } from "react";
import type { DashboardClient } from "../ghClient.js"; // verify path
import type { HealthInfo } from "../ghClient.js"; // verify path

export function useHealth(client: DashboardClient, pollMs: number): HealthInfo | null {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const h = await client.health();
      if (alive) setHealth(h);
    };
    void run();
    const id = setInterval(() => void run(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, pollMs]);
  return health;
}
```

Probe test: inject a fake `client.health` returning a marker; assert the Probe shows it after a tick. App wiring: `const health = useHealth(client, healthPollMs);`. Commit `refactor(tui): extract useHealth from App`.

### Task 4: `useQueueSnapshot`

**Files:** Create `src/tui/hooks/useQueueSnapshot.ts`, `tests/useQueueSnapshot.test.tsx`. Modify App.

**Interfaces:** `useQueueSnapshot(queueFn: () => Promise<QueueSnapshot>, pollMs: number): { queueSnap: QueueSnapshot | null; queueNow: Date }`. Moves App lines 324, 325, effect 936–950 verbatim. `queueNow` is the shared clock — App keeps passing it to Header/rail/lists/cards unchanged. Commit `refactor(tui): extract useQueueSnapshot from App`.

### Task 5: `useAssessHistory`

**Files:** Create `src/tui/hooks/useAssessHistory.ts`, `tests/useAssessHistory.test.tsx`. Modify App.

**Interfaces:** `useAssessHistory(fn: () => Promise<AssessHistory[]>, pollMs: number): Map<string, AssessHistory>`. Moves App line 326 + effect 954. Read the effect body first (it builds a Map from the array) and move it verbatim. Commit `refactor(tui): extract useAssessHistory from App`.

### Task 6: `useUpdateCheck`

**Files:** Create `src/tui/hooks/useUpdateCheck.ts`, `tests/useUpdateCheck.test.tsx`. Modify App.

**Interfaces:** `useUpdateCheck(fn?: () => Promise<UpdateInfo | null>): string | null` (returns `updateLatest`). Moves App line 377 + effect 972 (the 24h interval + fetch). Preserve the `fn?` absent → no chip behavior (tests omit it). Commit `refactor(tui): extract useUpdateCheck from App`.

### Task 7: `useBotLogin`

**Files:** Create `src/tui/hooks/useBotLogin.ts`, `tests/useBotLogin.test.tsx`. Modify App.

**Interfaces:** `useBotLogin(fn?: () => Promise<string | null>): string | null`. Moves App line 381 + effect 994 (fetch-once). Preserve `fn?` absent → null. Commit `refactor(tui): extract useBotLogin from App`.

### Task 8: `useReview`

**Files:** Create `src/tui/hooks/useReview.tsx`, `tests/useReview.test.tsx`. Modify App.

**Interfaces:** `useReview(client, showToast, aliveRef): { reviewState: ReviewState; …transitions }`. Read App lines 311 + all `setReviewState` closures (actionHandlers 1702–1834, key handlers 2418–2503, mouse 2621–2661) FIRST and enumerate the transitions before extracting. This is the cleanest LARGE domain (map §3: only outward calls are `client.*` + `showToast`). Expose each transition as a named callback the App handlers call. Commit `refactor(tui): extract useReview from App`.

### Task 9: `useCmdOutput`

**Files:** Create `src/tui/hooks/useCmdOutput.ts`, `tests/useCmdOutput.test.tsx`. Modify App.

**Interfaces:** `useCmdOutput(runCliFn, setView): { cmd: CmdState | null; cmdElapsed: number; runPaletteCommand: (name, extraArgs) => void }`. Moves App 333, 334, 1268 (`cmdTokenRef`), effect 1261 (elapsed ticker), 1269 (`runPaletteCommand`). Export `CmdState` from the hook. The monotonic `token` stale-guard (map: cmdTokenRef) must move intact. Commit `refactor(tui): extract useCmdOutput from App`.

### Task 10: `usePalette`

**Files:** Create `src/tui/hooks/usePalette.ts`, `tests/usePalette.test.tsx`. Modify App.

**Interfaces:** `usePalette({ runPaletteCommand, showToast, onRequestWizard, setView }): { paletteFilter, paletteSel, paletteArgsMode, paletteArgs, setters…, paletteEnter }`. Moves App 329–332 + `paletteEnter` (1295). Depends on `useCmdOutput` (Task 9) for `runPaletteCommand`. Commit `refactor(tui): extract usePalette from App`.

### Task 11: `useLogOverlay`

**Files:** Create `src/tui/hooks/useLogOverlay.tsx`, `tests/useLogOverlay.test.tsx`. Modify App.

**Interfaces:** `useLogOverlay({ logPath, logsPollMs?, logReaderDeps?, sysSection, view, scrollBy, toEnd }): { logOverlay, logFollow, logFilters, logSearchMode, logEntries, logActive, setLogOverlay, handleLogOverlayInput, onLogExpand }`. Moves App 363–374, 460 (`useLogTail`), 471 (`onLogExpand`), 2200 (`handleLogOverlayInput`). **CRITICAL:** `logReaderDeps` must pass through unchanged (undefined in prod) so `useLogTail`'s dep identity stays stable (App.tsx:123–126) — do not default it. `logActive` reads `sysSection`/`view` (nav spine inputs). Commit `refactor(tui): extract useLogOverlay from App`.

### Task 12: `useAddRepoForm`

**Files:** Create `src/tui/hooks/useAddRepoForm.ts`, `tests/useAddRepoForm.test.tsx`. Modify App.

**Interfaces:** `useAddRepoForm({ addEntry, showToast, setView, aliveRef, … }): { addRepoError, addRepoBusy, handleAddRepo }`. Moves App 327, 328, 1385 (`handleAddRepo`). `addEntry` is injected — in this task it is still App's inline `setWatchlistEntries` updater; Task 13 replaces that injection with `useWatchlist.addEntry`. The `aliveRef` unmount guard inside `handleAddRepo` (App:1031 guard) must be preserved (tuiApp has a test: "add-repo unmounting mid-validate does not write the watchlist"). Commit `refactor(tui): extract useAddRepoForm from App`.

---

## Task 13: `useWatchlist`

**Files:** Create `src/tui/hooks/useWatchlist.ts`, `tests/useWatchlist.test.tsx`. Modify App.

**Interfaces:**

- Produces: `useWatchlist(watchlistFile: string, configRepos: GithubRepoMapping[]): { repoMappings: GithubRepoMapping[]; watchlistEntries: WatchlistEntry[]; watchlistError: string | null; addEntry: (e: WatchlistEntry) => void; removeEntry: (nwo: string) => void }`

Moves App lines 273–277 (initial disk read + state), 387 (`repoMappings` memo). `addEntry`/`removeEntry` wrap the `setWatchlistEntries` + `writeWatchlist` logic currently inside `handleAddRepo` (write path) and `unwatch` (remove path). Read both call sites first to extract the exact write semantics (including the `watchlistError`-gates-writes rule).

- [ ] **Step 1: Probe unit test** — inject a fake `watchlistFile` (tmp), assert `repoMappings` = configRepos ∪ entries; `addEntry` appends and persists; `removeEntry` drops.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — move the disk-read initializer and `repoMappings` memo; implement `addEntry`/`removeEntry` calling `writeWatchlist` (import from `../watchlist.js`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Wire into App** — `const { repoMappings, watchlistError, addEntry, removeEntry } = useWatchlist(watchlistFile, configRepos);`. Rewire `useAddRepoForm`'s injected `addEntry` to this hook's `addEntry`. Leave `unwatch`'s issue/PR eviction in App for now (Task 14 provides `evictRepo`); `unwatch` calls `removeEntry(nwo)` for the watchlist half.
- [ ] **Step 6: Full suite green.**
- [ ] **Step 7: Commit** `refactor(tui): extract useWatchlist from App`.

---

## Task 14: `useGithubData` — the fused core

**Files:** Create `src/tui/hooks/useGithubData.ts`, `tests/useGithubData.test.tsx`. Modify App.

**Interfaces:**

- Consumes: `useToast`'s `showToast`, `useWatchlist`'s `repoMappings`, the nav spine (`currentNwo`, `view`, `pane`, `bodyKind`), `client`, `branchPrefix`, `refreshPollMs`, `aliveRef`.
- Produces:

```ts
useGithubData(opts: {
  client: DashboardClient;
  repoMappings: GithubRepoMapping[];
  nav: { currentNwo: string | null; view: View; pane: Pane; bodyKind: string | null };
  branchPrefix: string;
  refreshPollMs: number;
  showToast: (kind: ToastKind, text: string) => void;
  aliveRef: React.MutableRefObject<boolean>;
}): {
  issues: Record<string, DashIssue[]>;
  staleAt: Record<string, string | null>;
  prs: DashPr[];
  prStaleByRepo: Record<string, string | null>;
  selectedNum: Record<string, number>;
  prSel: { nwo: string; number: number } | null;
  pane3SelNum: number | null;
  refreshedAt: string | null;
  refreshing: boolean;
  refreshAll: () => Promise<void>;
  loadIssues: (nwo: string) => Promise<Delivery>;
  loadPrs: () => Promise<Delivery>;
  loadPrsFor: (nwo: string) => Promise<Delivery>;
  setIssueLabels: (nwo: string, number: number, labels: string[]) => void;
  setSelectedNum: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setPrSel: React.Dispatch<…>;
  setPane3SelNum: React.Dispatch<…>;
  evictRepo: (nwo: string) => void;
}
```

**This is the hard task. Split into three sub-commits, each keeping the full suite green.**

### 14a — data + loaders (no effects yet)

- [ ] Read App lines 282–306 (state/anchors), 335/338/341/343/653/661/670/806/808/893 (refs), 732 (`loadIssues`), 765 (`loadPrs`), 792 (`loadPrsFor`), 816 (`refreshAll`), 1017 (`setIssueLabels`). Note every nav-spine read (`currentNwo`, `bodyKindRef`, `nwoRef`, `viewRef`) and every `showToast` call — these become hook inputs.
- [ ] **Probe unit test (first, FAIL):** render the hook with a fake `client` whose `issues(nwo)`/`prs()` return fixtures and a fixed `nav`; assert `loadIssues` populates `issues[nwo]` and stamps `staleAt`; `loadPrs` populates `prs`; `refreshAll` does both and stamps `refreshedAt`.
- [ ] **Implement** the hook holding all data state + the loader callbacks, moving bodies verbatim. Replace App-local `nwoRef`/`viewRef` reads with the `nav` input (keep the refs _inside_ the hook, synced from `nav` via a one-line effect, to preserve the poll-cycle-reads-live-value behavior at App:806–808).
- [ ] **Wire into App** returning the data + loaders; App passes `nav={{ currentNwo, view, pane, bodyKind }}`. The three anchor effects and the poll effect STAY in App for 14a (they call the hook's loaders/setters). Full suite green. Commit `refactor(tui): extract useGithubData data+loaders (1/3)`.

### 14b — move the effects in

- [ ] Move the unified poll effect (911), the watchlist-sweep effect (1009), and the three anchor-validation effects (865 issue, 880 pr, 894 pane-3) INTO the hook. Each reads nav inputs + writes hook state. **Preserve `refreshAll`'s dep-array identity behavior exactly** (a `repoMappings` change must re-identify it — spec Risks): the hook's `refreshAll` deps include `repoMappings`, so effect 1009's "sweep on watchlist change" still fires.
- [ ] After moving, run the FULL suite — the black-box tests for refresh-on-repo-change, anchor-follows-selection, and PR-vanish behavior are the proof. If any fails, the dep identity or effect ordering diverged — diagnose against the specific failing assertion, do not paper over it.
- [ ] Commit `refactor(tui): move useGithubData effects into the hook (2/3)`.

### 14c — movers + evictRepo + unwatch rewire

- [ ] Move the B/C movers (`moveIssue`/`moveIssueTo` 1495/1500, `movePr`/`movePrTo` 1508/1513, `movePane3`/`movePane3To` 1538/1543) and window slices (`issueWindow` 654, `prWindow` 662, `pane3Window` 671) into the hook or expose the setters they need.
- [ ] Add `evictRepo(nwo)`: drops `issues[nwo]`/`staleAt[nwo]`/`prStaleByRepo[nwo]` and filters `prs` — the issue/PR half of the old `unwatch` (App 1359–1379).
- [ ] Rewire App's `unwatch` to `removeEntry(nwo)` (Task 13) + `github.evictRepo(nwo)` + `showToast`. Read the original `unwatch` (1331) to preserve toast text and ordering.
- [ ] Full suite green — the "unwatch removes the repo and its issues/PRs" black-box test is the proof. Commit `refactor(tui): useGithubData movers + evictRepo, rewire unwatch (3/3)`.

---

## Task 15: App composition cleanup

**Files:** Modify `src/tui/App.tsx`.

After Tasks 1–14, App's body should be: the nav-spine state (D), the shared mechanics (`useScroll`/mouse/`useGuardedInput`), the hook calls, the derivation stack (`bindingContext → chipActions`), the input handler, and the render tree. Verify no orphaned state/effects remain.

- [ ] **Step 1: Grep for leftovers** — `grep -nE "useState|useEffect" src/tui/App.tsx | wc -l`. Expected: only the nav spine (`view`/`pane`/`railSel`/`sectionCursor`/`repoDetailTarget` + the local-snapshot state if not separately extracted) and any effect that legitimately composes hooks. Document the final count in the commit.
- [ ] **Step 2: Confirm App line count** — `wc -l src/tui/App.tsx`. Record before/after (3077 → target).
- [ ] **Step 3: Full gate** — `npm run lint && npm run format:check && npm run typecheck && npm run build`, then `npx vitest run`. All green.
- [ ] **Step 4: Commit** (only if any cleanup edits were made) `refactor(tui): App composition cleanup after hook extraction`.

---

## Task 16: `React.memo` pass + measurement

**Files:** Modify the big render components: `src/tui/components/IssueList.tsx`, `PrList.tsx`, `UnifiedRail.tsx`, `RepoDetail.tsx`, `Preview.tsx`, `PrPreview.tsx`, `QueueView.tsx`, `OutboxSection`/`WorktreesSection`/`DaemonSection` (in `sections.tsx`), `ActivityCard.tsx`. Create `tests/renderPerf.test.tsx`.

**Interfaces:** Consumes `bumpRender`/`renderCounts` from Task 0.

- [ ] **Step 1: Add a `bumpRender("<Name>")` line** to the body of each target component (top of the function). These are no-ops unless `JUNCO_RENDER_COUNT=1`.
- [ ] **Step 2: Write the measurement test** `tests/renderPerf.test.tsx`: enable the flag, `renderApp()`, drive a sequence that triggers ONLY an unrelated poll (e.g. advance a fake health/queue timer without changing selection), and record `renderCounts()`. Assert nothing yet — first capture the PRE-memo numbers via `console.log`. Run it, record the counts.
- [ ] **Step 3: Wrap each target in `React.memo`** — `export const IssueList = React.memo(function IssueList(props: …) { … });` (or wrap the existing export). Do NOT change any component's output or props — memo only.
- [ ] **Step 4: Re-run the measurement test** — record POST-memo counts. Convert the test into an assertion: a poll that changes only `health` must NOT re-render `IssueList`/`PrList` (their count stays flat across the poll). Use `until()` for any timing.
- [ ] **Step 5: Full suite green** — memo must not change behavior. `npx vitest run > /tmp/all.txt 2>&1; echo "exit: $?"`.
- [ ] **Step 6: Commit** with the before/after render counts in the body: `perf(tui): memoize the big dashboard components`. If the measured delta is negligible (terminal re-render is cheap), SAY SO in the commit body — do not overstate.

---

## Task 17: Docs + close-out

**Files:** Modify `ARCHITECTURE.md` (TUI section), possibly `CLAUDE.md`.

- [ ] **Step 1:** Add a one-line note to `ARCHITECTURE.md`'s TUI module map: `src/tui/hooks/` holds the per-domain state hooks; `App.tsx` is the composition spine (nav state + binding router + render tree).
- [ ] **Step 2:** Only if a new gotcha emerged (e.g. a hook-extraction pitfall worth warning about), add ONE line to CLAUDE.md's testing-gotchas. Otherwise skip — do not pad.
- [ ] **Step 3: Final full gate + report.**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/final.txt 2>&1; echo "exit: $?"; grep -E "Test Files|Tests " /tmp/final.txt
echo "App.tsx: $(wc -l < src/tui/App.tsx) lines (was 3077)"
echo "hooks: $(ls src/tui/hooks/ | wc -l) files"
```

- [ ] **Step 4: Commit** `docs(tui): record the hooks layer in ARCHITECTURE.md`.

---

## Do-not-touch / preserve-exactly list

- **Nav spine** (`view`/`pane`/`railSel` + derived `currentNwo`/`sysSection`/`body`/`railIdx`) — stays in App. Never extract.
- **`useScroll`/`scrollKey`** (App 439/452) — one instance multiplexed across surfaces; stays.
- **Mouse hooks** (2177/2181) and **`MouseProvider`** — App mounts inside the provider; unchanged.
- **Both `useGuardedInput`** handlers (2190 quit, 2289 dispatch cascade) — the cascade reads/writes every domain; stays at composition level.
- **`bindingContext → bindings → actionHandlers → structuralChipActions → chipActions`** (1589–2162) — the single source of truth for chips + keys; stays.
- **`aliveRef`** (1031) — shared unmount guard across async continuations; stays in App, passed into hooks that need it (`useGithubData`, `useAddRepoForm`, `useReview`).
- **`logReaderDeps` = undefined in prod** — never default it (App 123–126).
- **`refreshAll` dep identity** — `repoMappings` must re-identify it (drives effect 1009). Do not stabilize it away.
- **Every black-box test** — none may be deleted or modified. Behavior is invariant.

## Follow-ups (file as issues, do not do here)

- If `useGithubData` proves too large to hold in context even after the 3-way split, consider splitting issues vs PRs into `useIssues`/`usePrs` sharing a `useUnifiedRefresh` — but only if a real maintenance need appears (YAGNI).
- The local-snapshot domain (E: `localCheap`/`localHeavy`/`sectionCursor`) was left in App as part of the nav-adjacent surface; a future `useLocalSnapshot` hook could extract it if warranted.
