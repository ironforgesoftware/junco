# Assess review — dashboard TUI (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard (Ink TUI) review view for the assess queue — list pending finding batches, per-finding checklist, confirm-to-file — and rewire the assess key so it works on repos the operator doesn't own.

**Architecture:** Plan 1 (SP-1, merged in #95) built the durable review store (`src/assessReview.ts`), the least-privilege filing core (`src/assessFiling.ts`), and the CLI (`junco assess review`/`file`). This plan surfaces the same store in the dashboard. The dashboard's `App` component has **no `cfg`** — it reaches all state/GitHub work through a `DashboardClient` (`src/tui/ghClient.ts`, which closes over `cfg`). So the review view gets two new client methods (`listReview`, `fileReview`) and a new presentational component (`ReviewView.tsx`); `App` wires the view, keys, and toasts.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), Ink/React TUI, vitest + `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-07-09-assess-any-repo-review-queue-design.md` (the "Surfaces → TUI" section). This is **Plan 2**; Plan 1 shipped in #95.

## Global Constraints

- **Branch:** `feat/assess-review-tui` off **latest `origin/main`** (`713257a`, which includes #95). Fetch + branch before Task 1.
- **ESM/NodeNext:** every intra-repo import ends in `.js` (including type-only imports of `PendingAssess`/`Finding`/`FileResult`).
- **App has no `cfg`.** `AppProps` exposes only `client: DashboardClient`, `configPath: string`, and cfg-derived scalars — never `cfg: Config`. The review view MUST reach the store through `client.listReview()`/`client.fileReview()`; do NOT add a `cfg` prop or call `listPending`/`fileFindings` from `App.tsx`. `ghClient.ts` is "the dashboard's ONLY GitHub-touching module" (its docstring) — keep it that way.
- **Two unions must both gain `"review"`:** `View` in `src/tui/App.tsx:77-86` AND `HintView` in `src/tui/components/Chrome.tsx:10-19`. `App.tsx:1434` casts `view as HintView`, so a missing `HintView` member is NOT a compile error — it silently yields `undefined` hints. Add both.
- **Ink test gotcha (has flaked a release gate):** never assert a fixed `setTimeout` tick after a state change. Use the repo's bounded-retry helper `until(cond, tries?)` from `tests/helpers/until.ts` (loops ≤50×20ms, final iteration asserts). Drive keys with `r.stdin.write(...)`, read frames with `r.lastFrame()`. Fixture harness: `renderApp(...)` in `tests/tuiApp.test.tsx`.
- **No new `Config` field.** No AI attribution in commits. Conventional commits; suite green at every commit.
- **Full gate before "done":** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly — never pipe into grep/tail.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/tui/ghClient.ts` | `listReview()` + `fileReview()` on `DashboardClient` (close over `cfg`, call the store) | Modify |
| `src/tui/components/ReviewView.tsx` | Presentational: batch list + per-finding checklist; owns `ReviewState`/`ReviewOpen` types | **Create** |
| `src/tui/App.tsx` | Rewire assess key; wire `"review"` view, state, open key, render arm, key routing, toasts | Modify |
| `src/tui/components/Chrome.tsx` | `HintView` union + `hintsFor` `case "review"` | Modify |
| `src/tui/components/HelpModal.tsx` | Register the review open key in "panes & views" | Modify |

Tests: colocated `tests/*.test.ts(x)`.

## Design notes (read before Task 1)

- **Two modes inside one `"review"` view.** `ReviewState.open === null` → **batch-list** mode (choose a pending batch). `open !== null` → **checklist** mode (toggle findings in that batch, confirm to file). `enter` in batch-list opens a batch; `esc` from checklist returns to batch-list; `esc` from batch-list returns to `main`.
- **`listReview()` returns full `PendingAssess[]`** (each already carries its `findings`), so opening a batch needs no second fetch.
- **Default selection = all findings checked**, sorted severity-desc. (The spec's `maxIssuesPerRun`-as-preselection is an explicit **non-goal** for this plan — YAGNI; all-checked is the simplest correct default, operator unchecks noise.)
- **After a successful file, optimistically remove the batch** from local state (there is no poll cycle for pending reviews, and `fileFindings` archives the batch server-side). Mirror the `runAction` optimistic pattern, not `dispatchTicket`'s poll-reconcile.
- **Empty selection guard:** if the checked set is empty, the confirm key toasts "nothing selected" and does NOT call `fileReview` (mirrors the CLI's no-selection guard; Plan 1's `fileFindings` also won't archive an empty selection).

---

### Task 1: `ghClient` — `listReview` + `fileReview`

**Files:**
- Modify: `src/tui/ghClient.ts`
- Test: the ghClient test file (find it: `ls tests | grep -i ghclient`; likely `tests/ghClient.test.ts`)

**Interfaces:**
- Consumes: `listPending`, `readPending`, `type PendingAssess` (`../assessReview.js`); `fileFindings`, `type FileResult` (`../assessFiling.js`).
- Produces on `DashboardClient`:
  - `listReview(): Promise<Result<PendingAssess[]>>`
  - `fileReview(id: string, fingerprints: string[]): Promise<Result<FileResult>>`
  - New injectable deps on `GhClientDeps`: `listPendingFn?: typeof listPending`, `readPendingFn?: typeof readPending`, `fileFindingsFn?: typeof fileFindings`.

- [ ] **Step 1: Write the failing test**

Add to the ghClient test file (match its existing `makeGhDashboardClient(cfg, deps)` construction + `Result` assertions):

```ts
it("listReview returns the pending batches", async () => {
  const batches = [{ id: "assess-x-1", nwo: "o/r", external: true, autoPlan: false, repoPath: "/x", createdAt: "2026-07-09T00:00:00.000Z", findings: [] }];
  const client = makeGhDashboardClient(cfgFixture(), { listPendingFn: () => batches as never });
  const r = await client.listReview();
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.map((b) => b.id)).toEqual(["assess-x-1"]);
});

it("fileReview reads the batch and files the selected fingerprints", async () => {
  const batch = { id: "assess-x-1", nwo: "o/r", external: true, autoPlan: false, repoPath: "/x", createdAt: "2026-07-09T00:00:00.000Z", findings: [{ fingerprint: "f1", kind: "code", severity: "high", ruleId: "R", title: "T", description: "", references: [] }] };
  let gotSelected: Set<string> | null = null;
  const client = makeGhDashboardClient(cfgFixture(), {
    readPendingFn: () => ({ batch: batch as never, error: null }),
    fileFindingsFn: (_c, _b, selected) => { gotSelected = selected; return Promise.resolve({ created: 1, queuedOffline: 0, deduped: 0, failed: 0, urls: [], warnings: [] }); },
  });
  const r = await client.fileReview("assess-x-1", ["f1"]);
  expect(r.ok).toBe(true);
  expect([...(gotSelected ?? new Set())]).toEqual(["f1"]);
});

it("fileReview surfaces a missing/corrupt batch as an error Result", async () => {
  const client = makeGhDashboardClient(cfgFixture(), { readPendingFn: () => ({ batch: null, error: null }) });
  const r = await client.fileReview("nope", ["f1"]);
  expect(r.ok).toBe(false);
});
```

(Reuse the test file's existing `cfgFixture()`/config builder.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ghClient.test.ts -t Review`
Expected: FAIL — `listReview`/`fileReview` not defined on the client.

- [ ] **Step 3: Write minimal implementation**

In `src/tui/ghClient.ts`: add the imports, extend `GhClientDeps` and the `DashboardClient` interface, and add the two methods inside `makeGhDashboardClient` (mirror the `dispatchTicket` closure + `attempt` pattern):

```ts
import { listPending, readPending, type PendingAssess } from "../assessReview.js";
import { fileFindings, type FileResult } from "../assessFiling.js";
```
Add to `GhClientDeps`:
```ts
  listPendingFn?: typeof listPending;
  readPendingFn?: typeof readPending;
  fileFindingsFn?: typeof fileFindings;
```
Add to the `DashboardClient` interface:
```ts
  listReview(): Promise<Result<PendingAssess[]>>;
  fileReview(id: string, fingerprints: string[]): Promise<Result<FileResult>>;
```
Add inside `makeGhDashboardClient` (next to `dispatchTicket`), resolving deps at the top of the factory like the others:
```ts
    listReview() {
      return attempt(async () => (deps.listPendingFn ?? listPending)(cfg));
    },
    fileReview(id, fingerprints) {
      return attempt(async () => {
        const { batch, error } = (deps.readPendingFn ?? readPending)(cfg, id);
        if (error) throw new Error(error);
        if (!batch) throw new Error(`no pending review '${id}'`);
        return (deps.fileFindingsFn ?? fileFindings)(cfg, batch, new Set(fingerprints), { ghFn });
      });
    },
```
(`ghFn` is already in scope in this factory — the same one `dispatchTicket` passes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ghClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/ghClient.ts tests/ghClient.test.ts
git commit -m "feat(tui): DashboardClient listReview + fileReview"
```

---

### Task 2: Rewire the assess key for external repos

**Files:**
- Modify: `src/tui/App.tsx` (`runAssess`, ~762-798)
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**
- Produces: `s`/`S` now submit an assess audit for external repos too (the CLI resolves them since #95). The stale external-refusal toast is removed.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiApp.test.tsx` (match `renderApp` + `until`). Seed an EXTERNAL repo in the watchlist fixture, capture `runCliFn` calls:

```ts
it("assess key submits an audit for an external repo (no refusal)", async () => {
  const cli: Array<[string, string[]]> = [];
  const runCli = async (name: string, args: string[]) => { cli.push([name, args]); return { output: "queued", code: 0, timedOut: false }; };
  // watchlist fixture with an external entry for nwo "up/stream" (mirror the file's existing external-repo test setup)
  const { client } = makeClient({ "up/stream": [] });
  const r = renderApp(client, wlExternal("up/stream"), 999999, runCli);
  await until(() => (r.lastFrame() ?? "").includes("up/stream"));
  r.stdin.write("s");
  await until(() => cli.length === 1);
  expect(cli[0][0]).toBe("assess");
  expect(cli[0][1]).toEqual(["up/stream"]);
});
```

(If the file lacks a helper that writes an external watchlist entry, add a small `wlExternal(nwo)` that writes `[{ nwo, path: <tmp>, external: true }]` via `writeWatchlist`, mirroring the existing `wl()` helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tuiApp.test.tsx -t "external repo (no refusal)"`
Expected: FAIL — the current gate shows the refusal toast and never calls `runCliFn`, so `cli.length` stays 0.

- [ ] **Step 3: Write minimal implementation**

In `src/tui/App.tsx` `runAssess`, DELETE the external gate (the whole block, ~772-775):

```ts
    // External (fork-PR) repos: assess files finding ISSUES on the target
    // repo — an upstream write the etiquette invariant forbids. assessCmd
    // already fails closed (external entries are not "watched"), but gate
    // here so the toast explains instead of suggesting a config change.
    if (currentRepo?.external === true) {
      showToast("error", "assess is not available for external repos — it files issues upstream");
      return;
    }
```

The comment is stale: since #95, `junco assess <external-nwo>` resolves and parks findings (filing is a separate human-confirmed step), so the refusal is wrong. Also update the success toast to point at the review view — change the success branch to append a hint:

```ts
        if (r.code === 0) {
          showToast("success", line ? `${nwo}: ${line} · v to review` : `assessed ${nwo} · v to review`);
        } else {
```

`currentRepo` is now unused by `runAssess` only if nothing else references it — leave the `currentRepo` dependency in the `useCallback` deps array only if still used; if lint flags it as unused, remove it from the deps array (the destructured `currentRepo` variable itself is used elsewhere in the component, so only the callback dep may change).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tuiApp.test.tsx`
Expected: PASS (fix any existing test that asserted the old refusal toast for external repos).

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx tests/tuiApp.test.tsx
git commit -m "feat(tui): assess key works on external repos (parks for review)"
```

---

### Task 3: `ReviewView` component

**Files:**
- Create: `src/tui/components/ReviewView.tsx`
- Test: `tests/reviewView.test.tsx`

**Interfaces:**
- Consumes: `type PendingAssess` (`../../assessReview.js`), `theme` (`../theme.js`), Ink `Box`/`Text`.
- Produces (exported):
  - `interface ReviewOpen { batchIdx: number; findingCursor: number; checked: Set<string> }`
  - `interface ReviewState { loading: boolean; error: string | null; batches: PendingAssess[]; cursor: number; open: ReviewOpen | null }`
  - `function ReviewView(props: { state: ReviewState; height: number; focused: boolean }): React.JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/reviewView.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ReviewView, type ReviewState } from "../src/tui/components/ReviewView.js";

const BATCH = {
  id: "assess-x-1", nwo: "o/r", external: true, autoPlan: false, repoPath: "/x",
  createdAt: "2026-07-09T00:00:00.000Z",
  findings: [
    { fingerprint: "f1", kind: "code", severity: "high", ruleId: "R", title: "SQL injection", description: "", references: [] },
    { fingerprint: "f2", kind: "code", severity: "low", ruleId: "R", title: "stale dep", description: "", references: [] },
  ],
};
function state(over: Partial<ReviewState>): ReviewState {
  return { loading: false, error: null, batches: [BATCH as never], cursor: 0, open: null, ...over };
}

describe("ReviewView", () => {
  it("batch-list mode lists batches with nwo + count", () => {
    const { lastFrame } = render(<ReviewView state={state({})} height={20} focused />);
    expect(lastFrame()).toContain("o/r");
    expect(lastFrame()).toContain("2"); // finding count
  });
  it("checklist mode shows findings with check glyphs and severity", () => {
    const s = state({ open: { batchIdx: 0, findingCursor: 0, checked: new Set(["f1"]) } });
    const frame = render(<ReviewView state={s} height={20} focused />).lastFrame() ?? "";
    expect(frame).toContain("SQL injection");
    expect(frame).toContain("stale dep");
    expect(frame).toMatch(/\[x\].*SQL injection/); // f1 checked
    expect(frame).toMatch(/\[ \].*stale dep/);     // f2 unchecked
  });
  it("empty state renders a hint", () => {
    expect(render(<ReviewView state={state({ batches: [], cursor: 0 })} height={20} focused />).lastFrame()).toContain("no pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reviewView.test.tsx`
Expected: FAIL — module `../src/tui/components/ReviewView.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/tui/components/ReviewView.tsx`. Mirror `IssueList`'s row styling (`backgroundColor={sel ? theme.selectionBg : undefined}`, a `▌` cursor column). Do its own windowing (slice a visible range around the cursor bounded by `height`).

```tsx
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { PendingAssess } from "../../assessReview.js";

export interface ReviewOpen {
  batchIdx: number;
  findingCursor: number;
  checked: Set<string>;
}
export interface ReviewState {
  loading: boolean;
  error: string | null;
  batches: PendingAssess[];
  cursor: number;
  open: ReviewOpen | null;
}

const SEV_COLOR: Record<string, string | undefined> = {
  critical: theme.danger, high: theme.danger, medium: theme.warn, low: undefined,
};

/** Visible slice of `len` rows around `cursor` within `rows` lines. */
function windowRange(len: number, cursor: number, rows: number): { start: number; end: number } {
  if (len <= rows) return { start: 0, end: len };
  let start = Math.max(0, cursor - Math.floor(rows / 2));
  start = Math.min(start, len - rows);
  return { start, end: start + rows };
}

export function ReviewView({
  state,
  height,
  focused,
}: {
  state: ReviewState;
  height: number;
  focused: boolean;
}): React.JSX.Element {
  const rows = Math.max(1, height - 2);
  if (state.loading) return <Box paddingX={1}><Text dimColor>loading pending reviews…</Text></Box>;
  if (state.error) return <Box paddingX={1}><Text color={theme.danger}>{state.error}</Text></Box>;

  // Checklist mode.
  if (state.open) {
    const batch = state.batches[state.open.batchIdx];
    if (!batch) return <Box paddingX={1}><Text dimColor>batch gone</Text></Box>;
    const { checked, findingCursor } = state.open;
    const w = windowRange(batch.findings.length, findingCursor, rows - 1);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text color={theme.accent}>{batch.nwo}</Text>
          <Text dimColor>{`  ${batch.external ? "external" : "owned"} · ${checked.size}/${batch.findings.length} selected`}</Text>
        </Text>
        {batch.findings.slice(w.start, w.end).map((f, i) => {
          const idx = w.start + i;
          const sel = idx === findingCursor && focused;
          const on = checked.has(f.fingerprint);
          return (
            <Box key={f.fingerprint} width="100%" backgroundColor={sel ? theme.selectionBg : undefined} gap={1}>
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
              <Text>{on ? "[x]" : "[ ]"}</Text>
              <Text color={SEV_COLOR[f.severity]}>{f.severity.padEnd(8)}</Text>
              <Box flexGrow={1} minWidth={0}><Text wrap="truncate" dimColor={!sel}>{f.title}</Text></Box>
            </Box>
          );
        })}
      </Box>
    );
  }

  // Batch-list mode.
  if (state.batches.length === 0) {
    return <Box paddingX={1}><Text dimColor>no pending assess reviews — run assess (s) on a repo first</Text></Box>;
  }
  const w = windowRange(state.batches.length, state.cursor, rows);
  return (
    <Box flexDirection="column" paddingX={1}>
      {state.batches.slice(w.start, w.end).map((b, i) => {
        const idx = w.start + i;
        const sel = idx === state.cursor && focused;
        return (
          <Box key={b.id} width="100%" backgroundColor={sel ? theme.selectionBg : undefined} gap={1}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Box flexGrow={1} minWidth={0}><Text wrap="truncate" dimColor={!sel}>{b.nwo}</Text></Box>
            <Text dimColor>{b.external ? "external" : "owned"}</Text>
            <Text color={theme.accent}>{`${b.findings.length}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

If `theme` lacks a `danger`/`warn`/`accent`/`selectionBg` key, read `src/tui/theme.ts` and use the actual key names (do NOT invent theme keys).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reviewView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ReviewView.tsx tests/reviewView.test.tsx
git commit -m "feat(tui): ReviewView component (batch list + per-finding checklist)"
```

---

### Task 4: Wire the review view into App (navigation)

**Files:**
- Modify: `src/tui/App.tsx`, `src/tui/components/Chrome.tsx`, `src/tui/components/HelpModal.tsx`
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**
- Consumes: `ReviewView`, `type ReviewState` (Task 3); `client.listReview()` (Task 1).
- Produces: a `"review"` view opened with `v`; batch-list navigation (↑/↓ cursor, enter → open a batch's checklist, esc → back). Filing arrives in Task 5.

- [ ] **Step 1: Write the failing test**

```ts
it("v opens the review view and enter drills into a batch's findings", async () => {
  const batches = [{ id: "assess-x-1", nwo: "o/r", external: true, autoPlan: false, repoPath: "/x", createdAt: "2026-07-09T00:00:00.000Z", findings: [{ fingerprint: "f1", kind: "code", severity: "high", ruleId: "R", title: "SQL injection", description: "", references: [] }] }];
  const { client } = makeClient({ "acme/api": [] });
  (client as { listReview: () => Promise<unknown> }).listReview = async () => ({ ok: true, value: batches });
  const r = renderApp(client, wl());
  await until(() => (r.lastFrame() ?? "").includes("acme/api"));
  r.stdin.write("v");
  await until(() => (r.lastFrame() ?? "").includes("o/r")); // batch listed
  r.stdin.write("\r"); // enter → checklist
  await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
  r.stdin.write(String.fromCharCode(27)); // esc → back to batch list
  await until(() => (r.lastFrame() ?? "").includes("o/r") && !(r.lastFrame() ?? "").includes("SQL injection"));
});
```

(`makeClient` in the test file builds a fake `DashboardClient`; add a `listReview` stub to its returned client — either extend `makeClient` to include it or override on the instance as above. Follow whichever the file already does for optional methods.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tuiApp.test.tsx -t "opens the review view"`
Expected: FAIL — `v` does nothing; no review view.

- [ ] **Step 3: Write minimal implementation**

1. **Unions.** Add `"review"` to `View` (`App.tsx:77-86`) and to `HintView` (`Chrome.tsx:10-19`).
2. **State.** Add near the other view state (`App.tsx:220`):
```ts
const [reviewState, setReviewState] = useState<ReviewState>({ loading: false, error: null, batches: [], cursor: 0, open: null });
```
   Import: `import { ReviewView, type ReviewState } from "./components/ReviewView.js";`
3. **Open key + fetch.** Next to the `s`/`S` block (`App.tsx:1247-1251`), add:
```ts
if (input === "v") {
  setReviewState((s) => ({ ...s, loading: true, error: null, open: null, cursor: 0 }));
  setView("review");
  void client.listReview().then((res) => {
    if (!aliveRef.current) return;
    if (res.ok) setReviewState((s) => ({ ...s, loading: false, batches: res.value, cursor: 0 }));
    else setReviewState((s) => ({ ...s, loading: false, error: res.error }));
  });
  return;
}
```
4. **Render arm.** In the ternary chain (`App.tsx:1502-1560`), add before the terminal `else`:
```tsx
) : view === "review" ? (
  <ReviewView state={reviewState} height={listHeight} focused />
```
5. **Key routing.** Add a `view === "review"` branch in the useInput cascade, BEFORE the `// ── main view ──` block (~`App.tsx:1158`), mirroring the `"queue"`/`"detail"` shape:
```ts
if (view === "review") {
  const rs = reviewState;
  if (rs.open) {
    const batch = rs.batches[rs.open.batchIdx];
    if (key.escape) return void setReviewState((s) => ({ ...s, open: null }));
    if ((input === "k" || key.upArrow))
      return void setReviewState((s) => (s.open ? { ...s, open: { ...s.open, findingCursor: Math.max(0, s.open.findingCursor - 1) } } : s));
    if ((input === "j" || key.downArrow))
      return void setReviewState((s) => (s.open && batch ? { ...s, open: { ...s.open, findingCursor: Math.min(batch.findings.length - 1, s.open.findingCursor + 1) } } : s));
    // toggle / file → Task 5
    return;
  }
  if (key.escape || input === "v") return void setView("main");
  if (input === "k" || key.upArrow) return void setReviewState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
  if (input === "j" || key.downArrow) return void setReviewState((s) => ({ ...s, cursor: Math.min(Math.max(0, s.batches.length - 1), s.cursor + 1) }));
  if (key.return) {
    return void setReviewState((s) => {
      const batch = s.batches[s.cursor];
      if (!batch) return s;
      return { ...s, open: { batchIdx: s.cursor, findingCursor: 0, checked: new Set(batch.findings.map((f) => f.fingerprint)) } };
    });
  }
  return;
}
```
   (Default selection = all findings checked, per design notes.)
6. **Chrome hints.** In `hintsFor` (`Chrome.tsx:177+`) add:
```ts
case "review":
  return [["↑/↓", "move"], ["enter", "open/file"], ["space", "toggle"], ["a/n", "all/none"], ["esc", "back"]];
```
7. **HelpModal.** In the "panes & views" section (`HelpModal.tsx:63-76`, near the `s`/`S` rows), add a row: `["v", "assess review queue"]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tuiApp.test.tsx` then `npm run typecheck` (catches a missed union member).
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/components/Chrome.tsx src/tui/components/HelpModal.tsx tests/tuiApp.test.tsx
git commit -m "feat(tui): review view — open, list batches, drill into findings"
```

---

### Task 5: Confirm-to-file interaction

**Files:**
- Modify: `src/tui/App.tsx`
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**
- Consumes: `client.fileReview(id, fingerprints)` (Task 1).
- Produces: in checklist mode — `space` toggles the finding at the cursor, `a` checks all, `n` none, `f`/`enter` files the checked set (empty → toast, no call); on success, toast the counts and optimistically remove the batch.

- [ ] **Step 1: Write the failing test**

```ts
it("toggling and pressing f files the selected fingerprints and drops the batch", async () => {
  const batches = [{ id: "assess-x-1", nwo: "o/r", external: true, autoPlan: false, repoPath: "/x", createdAt: "2026-07-09T00:00:00.000Z", findings: [
    { fingerprint: "f1", kind: "code", severity: "high", ruleId: "R", title: "SQL injection", description: "", references: [] },
    { fingerprint: "f2", kind: "code", severity: "low", ruleId: "R", title: "stale dep", description: "", references: [] },
  ] }];
  const filed: Array<[string, string[]]> = [];
  const { client } = makeClient({ "acme/api": [] });
  (client as { listReview: () => Promise<unknown> }).listReview = async () => ({ ok: true, value: batches });
  (client as { fileReview: (id: string, fps: string[]) => Promise<unknown> }).fileReview = async (id, fps) => { filed.push([id, fps]); return { ok: true, value: { created: fps.length, queuedOffline: 0, deduped: 0, failed: 0, urls: [], warnings: [] } }; };
  const r = renderApp(client, wl());
  await until(() => (r.lastFrame() ?? "").includes("acme/api"));
  r.stdin.write("v");
  await until(() => (r.lastFrame() ?? "").includes("o/r"));
  r.stdin.write("\r"); // open batch (all checked)
  await until(() => (r.lastFrame() ?? "").includes("SQL injection"));
  r.stdin.write("j");     // cursor to f2
  r.stdin.write(" ");     // uncheck f2
  await until(() => /\[ \].*stale dep/.test(r.lastFrame() ?? ""));
  r.stdin.write("f");     // file
  await until(() => filed.length === 1);
  expect(filed[0][0]).toBe("assess-x-1");
  expect(filed[0][1]).toEqual(["f1"]); // only f1 checked
  await until(() => (r.lastFrame() ?? "").includes("filed 1")); // toast
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tuiApp.test.tsx -t "files the selected fingerprints"`
Expected: FAIL — `space`/`f` do nothing yet.

- [ ] **Step 3: Write minimal implementation**

In the `view === "review"` → `if (rs.open)` branch (added in Task 4), replace the `// toggle / file → Task 5` line with:

```ts
    if (input === " ") {
      return void setReviewState((s) => {
        if (!s.open || !batch) return s;
        const checked = new Set(s.open.checked);
        const fp = batch.findings[s.open.findingCursor]?.fingerprint;
        if (fp) { checked.has(fp) ? checked.delete(fp) : checked.add(fp); }
        return { ...s, open: { ...s.open, checked } };
      });
    }
    if (input === "a") return void setReviewState((s) => (s.open && batch ? { ...s, open: { ...s.open, checked: new Set(batch.findings.map((f) => f.fingerprint)) } } : s));
    if (input === "n") return void setReviewState((s) => (s.open ? { ...s, open: { ...s.open, checked: new Set() } } : s));
    if (input === "f" || key.return) {
      if (!batch) return;
      const fps = batch.findings.map((f) => f.fingerprint).filter((fp) => rs.open!.checked.has(fp));
      if (fps.length === 0) return void showToast("info", "nothing selected");
      const id = batch.id;
      showToast("info", `filing ${fps.length} on ${batch.nwo}…`);
      void client.fileReview(id, fps).then((res) => {
        if (!aliveRef.current) return;
        if (res.ok) {
          const v = res.value;
          showToast("success", `filed ${v.created} · queued ${v.queuedOffline} · dup ${v.deduped} · failed ${v.failed}`);
          setReviewState((s) => {
            const batches = s.batches.filter((b) => b.id !== id); // optimistic removal
            return { ...s, batches, open: null, cursor: Math.min(s.cursor, Math.max(0, batches.length - 1)) };
          });
        } else {
          showToast("error", res.error);
        }
      });
      return;
    }
```

Update the Chrome `case "review"` hints to reflect `f` files (already added generically in Task 4; refine the label to `["f/enter", "file"]` if clearer).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tuiApp.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx tests/tuiApp.test.tsx
git commit -m "feat(tui): review checklist — toggle, select-all/none, confirm-to-file"
```

---

## Final verification (before opening the PR)

- [ ] **Full gate:** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — capture vitest exit explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`).
- [ ] **Manual drive (optional but recommended):** since this is TUI, sandbox-launch the dashboard against a throwaway state dir holding one pending batch and confirm `v` → toggle → `f` visually (never against the live runtime).
- [ ] **Attribution sweep:** `git log origin/main..HEAD --format='%b' | grep -i claude` returns nothing.
- [ ] **Docs:** flip the "TUI review view is deferred (Plan 2)" notes in `docs/dashboard.md` / `docs/assess.md` (added in #95) to describe the now-shipped `v` review view + checklist keys, stack-agnostic. Update the `dashboard.md` key table.
- [ ] **Merge `origin/main`** into the branch and re-run the gate.

## Self-review (completed by plan author)

- **Spec coverage:** review view (Tasks 3-5) · per-finding checklist + select (Tasks 3,5) · confirm-to-file via the store seam (Tasks 1,5) · `A`/`s` key rewire for external repos (Task 2) · Chrome/Help hints (Task 4). `maxIssuesPerRun`-preselection is an explicit non-goal (documented). Docs flip is in final verification.
- **Architecture invariant:** App reaches the store ONLY through `client.listReview`/`fileReview` (Task 1) — no `cfg` in `App.tsx`, matching the map's finding and the ghClient "only GitHub-touching module" rule.
- **Union hazard called out:** both `View` and `HintView` gain `"review"` (Task 4 Step 3.1), with the `view as HintView` cast caveat noted so typecheck-passing-but-blank-hints can't slip through.
- **Placeholders:** none — real code per step; theme-key and test-helper notes point at concrete existing symbols to read rather than invent.
- **Type consistency:** `ReviewState`/`ReviewOpen` defined once in `ReviewView.tsx` (Task 3) and imported by `App.tsx` (Task 4); `listReview`/`fileReview` signatures consistent across Tasks 1/4/5.
