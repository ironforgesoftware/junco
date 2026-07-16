# TUI Scroll Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every offset-driven TUI view from scrolling past the bottom of its content, and replace the TUI's three ad-hoc scroll states with one keyed `useScroll` hook.

**Architecture:** Two pure functions (`maxScroll`, `clampScroll`) join `windowSlice` in `src/tui/window.ts`. A single `useScroll(key)` hook owns the offset; a key change (view / section / draft / run token) resets it to 0, replacing 18 hand-written `setScroll(0)` calls. Each scroll surface clamps at slice time (so a blank pane is structurally impossible) and reports its `maxScroll` upward during render via an `onScrollMax` callback that writes a ref; the hook clamps every mutation against that max at **both** ends, so input is never dead and a shrunk list self-heals.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), React + Ink, vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-15-tui-scroll-clamp-design.md`

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict. **All relative imports carry the `.js` extension.**
- Prettier, 100 cols. Prettier may reformat between read and edit — re-read before editing, and run `npx prettier --write <files>` on touched files before committing.
- **The suite must be green at every commit.** New props on existing components are optional (`onScrollMax?`) so a component task lands before App wires it.
- Ink/TUI tests: **never assert one fixed `setTimeout` tick after a state change.** Use `until()` / `fireUntil()` from `tests/helpers/until.js`. This flake class burned a release gate.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, optional scope). **No AI attribution** — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line.
- Do not touch `windowSlice` or the cursor-driven lists (Rail, PrList, IssueList, ReviewView rows) — they already clamp correctly.
- No new dependencies.
- Never run `junco start` in this repo, and never touch `config.json`, `tickets/`, `worktrees/`, `launchd.*` — live runtime state.

## Two tests already depend on today's behavior

Discovered during planning — do not let these surprise you mid-task:

1. **`tests/tuiApp.test.tsx:2073`** — `"queue view scrolls with ] and ["` scrolls a **short** queue (1 running + 1 waiting) past the bottom on purpose. Its own comment says _"two `]` presses are needed to slice the RUNNING header out of the (unclamped) scroll window."_ Once the clamp lands, that content fits the viewport → `maxScroll` is 0 → `]` correctly does nothing → **this test fails.** Task 3 rewrites it.
2. **`tests/reviewView.test.tsx`** — four sites construct `open: { kind: "draft", draftIdx: 0, scroll: N }` (lines 114, 131, 139, 158). Task 9 removes `scroll` from `DraftOpen`, so these migrate to the new `scroll` prop in that same commit.

Every other `scroll={...}` in the test suite passes `0`, which clamps to `0` — those stay green.

## File Structure

| File                                    | Responsibility                                                            | Task    |
| --------------------------------------- | ------------------------------------------------------------------------- | ------- |
| `src/tui/window.ts`                     | + `maxScroll`, `clampScroll` (pure geometry, beside `windowSlice`)        | 1       |
| `src/tui/useScroll.ts`                  | **new** — the one scroll mechanic: offset + key reset + both-ends clamp   | 2       |
| `src/tui/components/QueueView.tsx`      | render clamp + report max                                                 | 3       |
| `src/tui/components/CommandOutput.tsx`  | render clamp + report max + fix footer counter                            | 4       |
| `src/tui/components/Preview.tsx`        | render clamp + report max + fix footer counter                            | 5       |
| `src/tui/components/LocalDashboard.tsx` | `DaemonSection` clamp + report max; pass-through                          | 6       |
| `src/tui/App.tsx`                       | one keyed `useScroll` replaces `scroll` + `localScroll`; 18 resets delete | 7, 8, 9 |
| `src/tui/components/ReviewView.tsx`     | draft takes a `scroll` prop; `DraftOpen.scroll` removed                   | 9       |

---

### Task 1: Pure geometry — `maxScroll` / `clampScroll`

**Files:**

- Modify: `src/tui/window.ts` (append after `windowSlice`)
- Test: `tests/tuiFoundation.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `maxScroll(total: number, height: number): number` and `clampScroll(offset: number, total: number, height: number): number`. Every later task imports these from `../window.js` (components) or `./window.js` (App).

- [ ] **Step 1: Write the failing test**

In `tests/tuiFoundation.test.ts`, change the `window.js` import line to:

```ts
import { windowSlice, maxScroll, clampScroll } from "../src/tui/window.js";
```

and add this block immediately after the `describe("windowSlice (follow-the-cursor)", ...)` block:

```ts
describe("maxScroll / clampScroll (bottom stop)", () => {
  it("content that fits never scrolls", () => {
    expect(maxScroll(3, 10)).toBe(0);
    expect(clampScroll(99, 3, 10)).toBe(0);
  });
  it("an exact fit never scrolls", () => {
    expect(maxScroll(10, 10)).toBe(0);
  });
  it("stops with the last row at the viewport bottom", () => {
    expect(maxScroll(20, 5)).toBe(15);
    expect(clampScroll(999, 20, 5)).toBe(15);
  });
  it("passes an in-range offset through untouched", () => {
    expect(clampScroll(7, 20, 5)).toBe(7);
  });
  it("clamps a negative offset to the top", () => {
    expect(clampScroll(-3, 20, 5)).toBe(0);
  });
  it("collapses a stale offset when the list shrinks under it", () => {
    expect(clampScroll(50, 12, 12)).toBe(0);
    expect(clampScroll(50, 14, 12)).toBe(2);
  });
  it("degenerate inputs return 0", () => {
    expect(maxScroll(0, 5)).toBe(0);
    expect(maxScroll(5, 0)).toBe(0);
    expect(clampScroll(4, 0, 5)).toBe(0);
    expect(clampScroll(4, 5, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiFoundation.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -20 /tmp/t1`

Expected: FAIL — `maxScroll`/`clampScroll` are not exported from `window.js`.

(Never pipe vitest into `grep`/`tail` directly: the pipeline reports the _filter's_ exit status, so a failing suite reads as green. Redirect, then echo `$?`.)

- [ ] **Step 3: Write the implementation**

Append to `src/tui/window.ts`:

```ts
/** Largest first-row offset that still fills a `height`-row viewport from
 * `total` rows: the last row lands at the BOTTOM of the viewport, never above
 * it, so blank rows are unreachable. Content that fits gives 0 — no scrolling. */
export function maxScroll(total: number, height: number): number {
  if (height <= 0 || total <= 0) return 0;
  return Math.max(0, total - height);
}

/** Clamp a scroll offset into `[0, maxScroll(total, height)]`. Clamps at BOTH
 * ends: a stale offset left over from a longer list collapses onto the new
 * bottom instead of slicing past it into an empty window. */
export function clampScroll(offset: number, total: number, height: number): number {
  return Math.min(Math.max(offset, 0), maxScroll(total, height));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tuiFoundation.test.ts > /tmp/t1 2>&1; echo "exit: $?"; tail -5 /tmp/t1`

Expected: exit 0, all tests pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/window.ts tests/tuiFoundation.test.ts
git add src/tui/window.ts tests/tuiFoundation.test.ts
git commit -m "feat(tui): maxScroll/clampScroll — the bottom-stop geometry"
```

---

### Task 2: The `useScroll` hook

**Files:**

- Create: `src/tui/useScroll.ts`
- Test: `tests/tuiUseScroll.test.tsx` (new)

**Interfaces:**

- Consumes: `maxScroll`, `clampScroll` from Task 1 (the hook itself only needs the clamp arithmetic inline; surfaces call `maxScroll`).
- Produces: `useScroll(key: string): ScrollHandle` where
  `ScrollHandle = { scroll: number; scrollBy: (d: number) => void; onScrollMax: (max: number) => void }`.
  Tasks 7–9 consume exactly these three names.

- [ ] **Step 1: Write the failing test**

Create `tests/tuiUseScroll.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { Text, useInput } from "ink";
import { render, cleanup } from "ink-testing-library";
import { useScroll } from "../src/tui/useScroll.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

/** A scroll surface in miniature: `total` rows in a `height`-row viewport,
 * reporting its own max during render exactly as the real components do. `]`
 * and `[` are the App's own scroll recipe. */
function Probe({ k, total, height }: { k: string; total: number; height: number }) {
  const { scroll, scrollBy, onScrollMax } = useScroll(k);
  onScrollMax(Math.max(0, total - height));
  useInput((input) => {
    if (input === "]") scrollBy(1);
    if (input === "[") scrollBy(-1);
  });
  return <Text>scroll={scroll}</Text>;
}

describe("useScroll", () => {
  it("stops at the bottom instead of scrolling past it", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 10; i++) r.stdin.write("]");
    // max = 8 - 4 = 4, however many times you press.
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    expect(r.lastFrame()).toContain("scroll=4");
  });

  it("does not scroll at all when the content fits", async () => {
    const r = render(<Probe k="a" total={3} height={10} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 5; i++) r.stdin.write("]");
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=0");
  });

  it("clamps at the top", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 5; i++) r.stdin.write("[");
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=0");
  });

  it("resets to the top when the key changes", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=1"));
    r.rerender(<Probe k="b" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
  });

  it("keeps the offset when the key is unchanged", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=1"));
    r.rerender(<Probe k="a" total={8} height={4} />);
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=1");
  });

  it("a surface that shrinks under the offset self-heals on the next press", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    for (let i = 0; i < 10; i++) r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    // Same surface (same key), fewer rows: max is now 0. The next press must
    // renormalize rather than step down from the stale 4.
    r.rerender(<Probe k="a" total={4} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiUseScroll.test.tsx > /tmp/t2 2>&1; echo "exit: $?"; tail -20 /tmp/t2`

Expected: FAIL — cannot resolve `../src/tui/useScroll.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tui/useScroll.ts`:

```ts
import { useCallback, useRef, useState } from "react";

export interface ScrollHandle {
  /** Clamped first-row offset for the mounted scroll surface. */
  scroll: number;
  /** Move by `d` rows, clamped into `[0, max]` at BOTH ends. Clamping the up
   * direction too is what lets a surface that shrank under the offset
   * renormalize on the next press instead of stepping down from a stale value. */
  scrollBy: (d: number) => void;
  /** Called by the mounted surface DURING its render with its own
   * `maxScroll(total, height)`. Writes a ref, never state, so it cannot loop. */
  onScrollMax: (max: number) => void;
}

/** The TUI's one scroll mechanic, for every offset-driven surface.
 *
 * `key` is the mounted surface's content identity — view name, `local:<section>`,
 * `cmd:<token>`, `detail:<nwo>#<n>`, `draft:<idx>`. A key change resets the
 * offset to 0, which makes "reset when the content changes" a lifecycle rather
 * than a call each new transition has to remember (it was hand-written at 18
 * sites before this hook).
 *
 * Nothing here assumes a single instance: offset surfaces are mutually
 * exclusive today, so App holds one, but a split pane would just call it twice. */
export function useScroll(key: string): ScrollHandle {
  const [scroll, setScroll] = useState(0);
  const maxRef = useRef(0);
  const keyRef = useRef(key);

  // Reset-on-key-change derived during render — React's documented "adjust state
  // when a prop changes" pattern: React re-runs this component with the new
  // state before committing, so no frame paints the stale offset. `current`
  // keeps THIS pass correct too, rather than relying on the discarded output.
  let current = scroll;
  if (keyRef.current !== key) {
    keyRef.current = key;
    maxRef.current = 0; // the newly mounted surface reports its own max this render
    current = 0;
    if (scroll !== 0) setScroll(0);
  }

  const scrollBy = useCallback((d: number) => {
    setScroll((s) => Math.max(0, Math.min(s + d, maxRef.current)));
  }, []);

  const onScrollMax = useCallback((max: number) => {
    maxRef.current = max;
  }, []);

  return { scroll: current, scrollBy, onScrollMax };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tuiUseScroll.test.tsx > /tmp/t2 2>&1; echo "exit: $?"; tail -8 /tmp/t2`

Expected: exit 0, 6 tests pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/useScroll.ts tests/tuiUseScroll.test.tsx
git add src/tui/useScroll.ts tests/tuiUseScroll.test.tsx
git commit -m "feat(tui): useScroll — one keyed scroll mechanic with a both-ends clamp"
```

---

### Task 3: `QueueView` — render clamp, report max, and rewrite the test that relied on overscroll

**Files:**

- Modify: `src/tui/components/QueueView.tsx` (props block; the window block at ~`:218`)
- Test: `tests/tuiQueue.test.tsx`, `tests/tuiApp.test.tsx:2073` (rewrite)

**Interfaces:**

- Consumes: `clampScroll`, `maxScroll` from `../window.js` (Task 1).
- Produces: `QueueView` gains optional `onScrollMax?: (max: number) => void`. Tasks 7 and 8 pass the hook's `onScrollMax` to it.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiQueue.test.tsx` inside the existing top-level `describe` for `QueueView`:

```tsx
it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
  const many: QueueSnapshot = {
    ...IDLE,
    waiting: Array.from({ length: 12 }, (_, i) => ({
      id: `manual-row-${String(i).padStart(2, "0")}`,
      github: null,
      kind: "pr" as const,
      priority: "normal" as const,
      retryCount: 0,
      notBefore: null,
      deferred: false,
    })),
  };
  const f = render(
    <QueueView snap={many} scroll={999} now={NOW} height={8} focused />,
  ).lastFrame()!;
  expect(f).toContain("row-11"); // the last row is on screen…
  expect(f).not.toContain("row-00"); // …and the window really did stop at the bottom
});

it("reports its max scroll to the owner", () => {
  let reported: number | null = null;
  render(
    <QueueView
      snap={IDLE}
      scroll={0}
      now={NOW}
      height={8}
      focused
      onScrollMax={(m) => {
        reported = m;
      }}
    />,
  );
  expect(reported).toBe(0); // an idle queue fits — nothing to scroll
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiQueue.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -20 /tmp/t3`

Expected: FAIL — the clamp test renders a blank window (`row-11` absent), and `onScrollMax` is not a prop.

- [ ] **Step 3: Write the implementation**

In `src/tui/components/QueueView.tsx`, add the import (merge into the existing `../window.js` import if one is already present):

```ts
import { clampScroll, maxScroll } from "../window.js";
```

Add to the props type, right after the `onRowPress?` entry:

```ts
  /** Reports `maxScroll(rows, visible)` to the owner DURING render, so the
   * owning hook can clamp its offset without duplicating this row arithmetic. */
  onScrollMax?: (max: number) => void;
```

and to the destructured parameter list, after `onRowPress,`:

```ts
  onScrollMax,
```

Then replace the window block (currently `const visible = ...` / `let start = scroll;`):

```ts
const visible = Math.max(1, height - 3);
onScrollMax?.(maxScroll(rows.length, visible));
// Clamp the base offset BEFORE the selected-row nudge below, so a stale or
// past-the-end `scroll` can never slice an empty window; cursor-following is
// unchanged.
let start = clampScroll(scroll, rows.length, visible);
if (selRowIndex !== null) {
  if (selRowIndex < start) start = selRowIndex;
  else if (selRowIndex >= start + visible) start = selRowIndex - visible + 1;
}
```

- [ ] **Step 4: Rewrite the App test that depended on overscroll**

`tests/tuiApp.test.tsx:2073` (`"queue view scrolls with ] and ["`) scrolls a short queue past its bottom on purpose; with the clamp its content fits, so `]` is correctly a no-op and the test fails. Replace the whole `it(...)` block with a version whose queue is genuinely taller than the pane:

```tsx
it("queue view scrolls with ] and [, and stops at the bottom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-tui-q3-"));
  const { client } = makeClient({ "acme/api": [rawIssue] });
  // A queue taller than the pane — the clamp makes a short queue unscrollable
  // (correctly), so overscroll can no longer stand in for real scrolling.
  const tall: QueueSnapshot = {
    ...QUEUE_SNAP,
    waiting: Array.from({ length: 30 }, (_, i) => ({
      id: `manual-row-${String(i).padStart(2, "0")}`,
      github: null,
      kind: "pr" as const,
      priority: "normal" as const,
      retryCount: 0,
      notBefore: null,
      deferred: false,
    })),
  };
  const r = renderApp(client, join(dir, "wl.json"), 999999, undefined, async () => tall);
  await until(() => (r.lastFrame() ?? "").includes("#46 exec"));
  r.stdin.write("t");
  await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  // ] scrolls the RUNNING header out of the window…
  r.stdin.write("]");
  r.stdin.write("]");
  await until(() => !(r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  // …and [ brings it back.
  r.stdin.write("[");
  r.stdin.write("[");
  await until(() => (r.lastFrame() ?? "").includes("RUNNING (1/1)"));
  // Pressing well past the end parks at the bottom: the last row stays visible
  // and the pane never blanks.
  for (let i = 0; i < 60; i++) r.stdin.write("]");
  await until(() => (r.lastFrame() ?? "").includes("row-29"));
  expect(r.lastFrame()).toContain("row-29");
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/tuiQueue.test.tsx tests/tuiApp.test.tsx > /tmp/t3 2>&1; echo "exit: $?"; tail -8 /tmp/t3`

Expected: exit 0. If the App test's final assertion is flaky, widen the `until` bound — do **not** swap it for a fixed tick.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx tests/tuiApp.test.tsx
git add src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx tests/tuiApp.test.tsx
git commit -m "fix(tui): clamp QueueView's scroll window to the last row"
```

---

### Task 4: `CommandOutput` — render clamp, report max, honest footer counter

**Files:**

- Modify: `src/tui/components/CommandOutput.tsx` (props; `:25`–`:31`; footer `:53`)
- Test: `tests/tuiComponents.test.tsx`

**Interfaces:**

- Consumes: `clampScroll`, `maxScroll` from `../window.js`.
- Produces: `CommandOutput` gains optional `onScrollMax?: (max: number) => void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiComponents.test.tsx` (import `CommandOutput` from `../src/tui/components/CommandOutput.js` if the file does not already):

```tsx
describe("CommandOutput scroll clamp", () => {
  const OUT = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n");

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    const f = render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={999}
        exitCode={0}
        timedOut={false}
        height={10}
      />,
    ).lastFrame()!;
    expect(f).toContain("line-19");
    expect(f).not.toContain("line-00");
  });

  it("the footer counter never runs past the total", () => {
    const f = render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={999}
        exitCode={0}
        timedOut={false}
        height={10}
      />,
    ).lastFrame()!;
    // height 10 → visibleLines 5 → max 15 → the window is rows 16-20 of 20.
    expect(f).toContain("16-20/20");
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <CommandOutput
        title="junco doctor"
        running={false}
        elapsedS={1}
        output={OUT}
        scroll={0}
        exitCode={0}
        timedOut={false}
        height={10}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(15); // 20 lines − 5 visible
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiComponents.test.tsx > /tmp/t4 2>&1; echo "exit: $?"; tail -20 /tmp/t4`

Expected: FAIL — blank window, footer reads `1000-20/20`, and `onScrollMax` is not a prop.

- [ ] **Step 3: Write the implementation**

In `src/tui/components/CommandOutput.tsx`, add:

```ts
import { clampScroll, maxScroll } from "../window.js";
```

Add `onScrollMax?: (max: number) => void;` to the props type and `onScrollMax,` to the destructured list.

Replace the slice (currently `const visible = lines.slice(scroll, scroll + visibleLines);`) so it clamps and the footer reports the clamped window:

```ts
const lines = output === "" ? [] : output.split("\n");
onScrollMax?.(maxScroll(lines.length, visibleLines));
const start = clampScroll(scroll, lines.length, visibleLines);
const visible = lines.slice(start, start + visibleLines);
```

and in the footer, replace both `scroll` reads with `start`:

```tsx
<Text dimColor>
  ↑/↓ scroll · {start + 1}-{Math.min(start + visibleLines, lines.length)}/{lines.length}
</Text>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tuiComponents.test.tsx tests/tuiPalette.test.tsx > /tmp/t4 2>&1; echo "exit: $?"; tail -8 /tmp/t4`

Expected: exit 0 (`tuiPalette.test.tsx` also renders `CommandOutput` — it passes `scroll={0}`, which clamps to `0`, so it must stay green).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/CommandOutput.tsx tests/tuiComponents.test.tsx
git add src/tui/components/CommandOutput.tsx tests/tuiComponents.test.tsx
git commit -m "fix(tui): clamp CommandOutput's scroll window and its footer counter"
```

---

### Task 5: `Preview` — render clamp, report max, honest footer counter

**Files:**

- Modify: `src/tui/components/Preview.tsx` (props `:16`–`:23`; `:45`–`:50`; footer `:91`)
- Test: `tests/tuiPreview.test.tsx`

**Interfaces:**

- Consumes: `clampScroll`, `maxScroll` from `../window.js`.
- Produces: `Preview` gains optional `onScrollMax?: (max: number) => void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiPreview.test.tsx`, reusing that file's existing `ISSUE` fixture (`DashIssue`, declared at `:7`):

```tsx
describe("Preview scroll clamp", () => {
  const BODY = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join(
    "\n",
  );

  it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
    const f = render(
      <Preview
        issue={ISSUE}
        trigger="junco"
        body={BODY}
        planComment={null}
        loading={false}
        error={null}
        scroll={999}
        focused
        height={14}
      />,
    ).lastFrame()!;
    expect(f).toContain("(no plan posted yet)"); // the last built line
    expect(f).not.toContain("line-00");
  });

  it("reports its max scroll to the owner", () => {
    let reported: number | null = null;
    render(
      <Preview
        issue={ISSUE}
        trigger="junco"
        body={"only one line"}
        planComment={null}
        loading={false}
        error={null}
        scroll={0}
        focused
        height={14}
        onScrollMax={(m) => {
          reported = m;
        }}
      />,
    );
    expect(reported).toBe(0); // 3 built lines in an 8-row viewport — nothing to scroll
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiPreview.test.tsx > /tmp/t5 2>&1; echo "exit: $?"; tail -20 /tmp/t5`

Expected: FAIL — blank window and no `onScrollMax` prop.

- [ ] **Step 3: Write the implementation**

In `src/tui/components/Preview.tsx`, add:

```ts
import { clampScroll, maxScroll } from "../window.js";
```

Add `onScrollMax?: (max: number) => void;` to `PreviewProps` (after `onWheel`) and `onScrollMax,` to the destructured list.

Replace the slice at the end of the line-building block:

```ts
onScrollMax?.(maxScroll(lines.length, viewHeight));
const start = clampScroll(scroll, lines.length, viewHeight);
const visible = lines.slice(start, start + viewHeight);
```

and in the footer (currently `{scroll + 1}-{Math.min(scroll + viewHeight, lines.length)}/{lines.length}`), replace both `scroll` reads with `start`:

```tsx
          ↑/↓ scroll · {start + 1}-{Math.min(start + viewHeight, lines.length)}/{lines.length}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tuiPreview.test.tsx > /tmp/t5 2>&1; echo "exit: $?"; tail -8 /tmp/t5`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Preview.tsx tests/tuiPreview.test.tsx
git add src/tui/components/Preview.tsx tests/tuiPreview.test.tsx
git commit -m "fix(tui): clamp Preview's scroll window and its footer counter"
```

---

### Task 6: `DaemonSection` — render clamp, report max, `LocalDashboard` pass-through

**Files:**

- Modify: `src/tui/components/LocalDashboard.tsx` (`DaemonSection` props `:405`–`:417` and its slice at `:519`; `LocalDashboard` props `:526`–`:553`; the `body` fan-out at `:578`–`:625`)
- Test: `tests/tuiLocal.test.tsx`

**Interfaces:**

- Consumes: `clampScroll`, `maxScroll` from `../window.js`; `QueueView`'s `onScrollMax` (Task 3).
- Produces: `DaemonSection` and `LocalDashboard` both gain optional `onScrollMax?: (max: number) => void`. `LocalDashboard` forwards it to **both** `QueueView` (queue section) and `DaemonSection` (daemon section) — they are the two offset surfaces in LOCAL mode, and only one is mounted at a time.

- [ ] **Step 1: Write the failing test**

Add to `tests/tuiLocal.test.tsx`, near the existing `DaemonSection` tests:

```tsx
it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
  // A daemon with many progress rows — taller than a short pane.
  const busy = {
    ...DAEMON,
    progress: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `manual-row-${String(i).padStart(2, "0")}`,
        { turns: i, lastTool: "bash", outputTokens: 100 + i },
      ]),
    ),
  };
  const f = render(<DaemonSection daemon={busy} scroll={999} height={8} focused />).lastFrame()!;
  expect(f).toContain("row-11");
  expect(f).not.toContain("row-00");
});

it("reports its max scroll to the owner", () => {
  let reported: number | null = null;
  render(
    <DaemonSection
      daemon={DAEMON}
      scroll={0}
      height={40}
      focused
      onScrollMax={(m) => {
        reported = m;
      }}
    />,
  );
  expect(reported).toBe(0); // a tall pane fits the whole panel
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tuiLocal.test.tsx > /tmp/t6 2>&1; echo "exit: $?"; tail -20 /tmp/t6`

Expected: FAIL — blank window and no `onScrollMax` prop.

- [ ] **Step 3: Write the implementation**

In `src/tui/components/LocalDashboard.tsx`, add to the existing `../window.js` import (it already imports `windowSlice`):

```ts
import { windowSlice, clampScroll, maxScroll } from "../window.js";
```

Add `onScrollMax?: (max: number) => void;` to `DaemonSection`'s props type and `onScrollMax,` to its destructured list. Replace its return (currently the `React.cloneElement(border, {}, lines.slice(scroll, scroll + Math.max(1, height - 3)))` line):

```ts
const visible = Math.max(1, height - 3);
onScrollMax?.(maxScroll(lines.length, visible));
const start = clampScroll(scroll, lines.length, visible);
return React.cloneElement(border, {}, lines.slice(start, start + visible));
```

Add `onScrollMax?: (max: number) => void;` to `LocalDashboard`'s props type (after `onDaemonWheel`) and `onScrollMax,` to its destructured list. Then forward it in the `body` fan-out — on the `QueueView` element:

```tsx
onRowPress = { onRowPress };
onScrollMax = { onScrollMax };
```

and on the `DaemonSection` element:

```tsx
onWheel = { onDaemonWheel };
onScrollMax = { onScrollMax };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tuiLocal.test.tsx > /tmp/t6 2>&1; echo "exit: $?"; tail -8 /tmp/t6`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
git add src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
git commit -m "fix(tui): clamp DaemonSection's scroll window; forward onScrollMax"
```

---

### Task 7: App — one keyed `useScroll` replaces the `scroll` state (14 resets delete)

**Files:**

- Modify: `src/tui/App.tsx` — state `:262`; key handlers `:1559`–`:1640`; resets `:842`, `:1041`, `:1561`, `:1585`, `:1595`, `:1631`, `:1861`, `:1869`, `:2157`, `:2166`, `:2175`, `:2182`, `:2206`, `:2210`; render `:2484`–`:2520`
- Test: `tests/tuiApp.test.tsx` (must stay green — Task 3 already rewrote the one test that relied on overscroll)

**Interfaces:**

- Consumes: `useScroll` (Task 2); `onScrollMax` on `QueueView` (Task 3), `CommandOutput` (Task 4), `Preview` (Task 5).
- Produces: `scroll`, `scrollBy`, `onScrollMax` in App's scope; a `scrollKey` memo that Tasks 8 and 9 reuse unchanged.

- [ ] **Step 1: Add the hook and the key, delete the `scroll` state**

Add the import beside the other `./` TUI imports in `src/tui/App.tsx`:

```ts
import { useScroll } from "./useScroll.js";
```

Delete `const [scroll, setScroll] = useState(0);` (`:262`) and put the hook where the offset surfaces' inputs are all in scope — after the `cmd`, `detail`, `reviewState`, `uiMode`, and `localSection` declarations:

```ts
// One scroll mechanic for every offset-driven surface. Exactly one is mounted
// at a time (the render tree is config | local | review | rail+one-of), so one
// instance serves them all; the key is the mounted surface's content identity,
// and a key change is what resets the offset — this replaces the 18
// hand-written setScroll(0)/setLocalScroll(0) calls that used to stand in for
// a lifecycle.
const scrollKey = useMemo(() => {
  if (uiMode === "local") return `local:${localSection}`;
  if (view === "review" && reviewState.open?.kind === "draft")
    return `draft:${reviewState.open.draftIdx}`;
  if (view === "cmdOutput" && cmd) return `cmd:${cmd.token}`;
  if (view === "detail" && detail) return `detail:${detail.nwo}#${detail.issue.number}`;
  return view;
}, [uiMode, localSection, view, reviewState.open, cmd, detail]);
const { scroll, scrollBy, onScrollMax } = useScroll(scrollKey);
```

Ensure `useMemo` is in the `react` import.

(The `local:` and `draft:` branches are written now and used in Tasks 8 and 9; until then those surfaces still read their own state, and a key they don't consume is harmless.)

- [ ] **Step 2: Replace the handlers and delete the resets**

Keyboard cascade — `view === "detail"` (`:1559`):

```ts
if (view === "detail") {
  if (key.escape) return void setView("main");
  if (input === "o") return void openDetailIssueInBrowser();
  if (input === "]" || key.downArrow) return void scrollBy(1);
  if (input === "[" || key.upArrow) return void scrollBy(-1);
  return;
}
```

`view === "queue"` (`:1583`):

```ts
if (view === "queue") {
  if (key.escape || input === "t") return void setView("main");
  if (input === "]" || key.downArrow) return void scrollBy(1);
  if (input === "[" || key.upArrow) return void scrollBy(-1);
  return;
}
```

`view === "prs"` (`:1593`) — drop only the `setScroll(0)` line:

```ts
if (key.escape || input === "p") return void setView("main");
```

`view === "cmdOutput"` (`:1629`):

```ts
if (view === "cmdOutput") {
  if (key.escape) return void setView("palette");
  if (input === "]" || key.downArrow) return void scrollBy(1);
  if (input === "[" || key.upArrow) return void scrollBy(-1);
  if (input === "r" && cmd && !cmd.running) {
    return void runPaletteCommand(cmd.name, cmd.extraArgs);
  }
  return;
}
```

Delete the bare `setScroll(0);` lines at `:842` (issue detail open), `:1041` (`runPaletteCommand`), `:1861` (`t` → queue), and `:1869` (`p` → prs), keeping the surrounding statements. In the `footerActions` map, delete the `setScroll(0);` lines at `:2157`, `:2166`, `:2175`, `:2182`, `:2206`, `:2210`, collapsing each body to its `setView(...)` (and, for `p`, the `refreshAll` call).

- [ ] **Step 3: Wire the render tree**

`QueueView` (`:2484`):

```tsx
          {view === "queue" ? (
            <ClickableBox flexGrow={1} onWheel={(d) => scrollBy(d)}>
              <QueueView
                snap={queueSnap}
                scroll={scroll}
                now={queueNow}
                height={listHeight}
                focused
                onScrollMax={onScrollMax}
              />
            </ClickableBox>
```

`CommandOutput` — same treatment: `onWheel={(d) => scrollBy(d)}` on its `ClickableBox`, and `onScrollMax={onScrollMax}` on the element.

`Preview` (`:2508`): replace `onWheel={(d) => setScroll((s) => Math.max(0, s + d))}` with `onWheel={(d) => scrollBy(d)}` and add `onScrollMax={onScrollMax}`.

- [ ] **Step 4: Verify no `setScroll` remains**

Run:

```bash
grep -n "setScroll" src/tui/App.tsx; echo "hits: $?"
```

Expected: no output (`hits: 1` — grep found nothing). Any remaining hit is an unconverted site.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/tuiApp.test.tsx tests/tuiMouseApp.test.tsx tests/tuiPalette.test.tsx > /tmp/t7 2>&1; echo "exit: $?"; tail -12 /tmp/t7`

Expected: exit 0.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep -E "src/tui|tests/tui" | head
npx prettier --write src/tui/App.tsx
git add src/tui/App.tsx
git commit -m "refactor(tui): App scroll via one keyed useScroll; drop 14 manual resets"
```

---

### Task 8: App — fold `localScroll` onto the same hook (4 resets delete)

**Files:**

- Modify: `src/tui/App.tsx` — state `:301`; `moveLocalSection` `:369`; `g`/`G` `:1489`, `:1494`; daemon keys `:1409`–`:1410`; `localSectionPress` `:2109`; render `:2445`–`:2452`
- Test: `tests/tuiLocalApp.test.tsx`, `tests/tuiLocal.test.tsx`

**Interfaces:**

- Consumes: `scroll` / `scrollBy` / `onScrollMax` and the `scrollKey` memo's `local:${localSection}` branch (Task 7); `LocalDashboard`'s `onScrollMax` (Task 6).
- Produces: no new names. `localScroll` ceases to exist.

- [ ] **Step 1: Delete the state and its four resets**

Delete `const [localScroll, setLocalScroll] = useState(0);` (`:301`).

`moveLocalSection` (`:365`) — the key already changes with `localSection`, so the reset is now automatic:

```ts
const moveLocalSection = (delta: number): void => {
  const i = LOCAL_SECTIONS.indexOf(localSection);
  const next = Math.max(0, Math.min(i + delta, LOCAL_SECTIONS.length - 1));
  setLocalSection(LOCAL_SECTIONS[next]);
};
```

Delete the `setLocalScroll(0);` lines in the `g` (`:1489`) and `G` (`:1494`) handlers and in `localSectionPress` (`:2109`), keeping their `setLocalSection(...)` / `setLocalFocus(...)` statements.

- [ ] **Step 2: Convert the daemon-panel keys**

`:1408`–`:1410`:

```ts
      if (localSection === "daemon") {
        if (input === "[" || key.upArrow) return void scrollBy(-1);
        if (input === "]" || key.downArrow) return void scrollBy(1);
```

- [ ] **Step 3: Wire the render**

On the `<LocalDashboard .../>` element (`:2445`):

```tsx
          scroll={scroll}
          ...
          onDaemonWheel={(d) => scrollBy(d)}
          onScrollMax={onScrollMax}
```

- [ ] **Step 4: Verify no `setLocalScroll` remains**

Run:

```bash
grep -n "setLocalScroll\|localScroll" src/tui/App.tsx; echo "hits: $?"
```

Expected: no output.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/tuiLocalApp.test.tsx tests/tuiLocal.test.tsx tests/tuiLocalActions.test.tsx > /tmp/t8 2>&1; echo "exit: $?"; tail -12 /tmp/t8`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/App.tsx
git add src/tui/App.tsx
git commit -m "refactor(tui): fold localScroll onto the shared useScroll instance"
```

---

### Task 9: `ReviewView` draft — take a `scroll` prop, drop `DraftOpen.scroll`

**Files:**

- Modify: `src/tui/components/ReviewView.tsx` (`DraftOpen` `:14`–`:18`; props `:55`–`:69`; draft body `:87`–`:122`)
- Modify: `src/tui/App.tsx` (draft keys `:1645`–`:1662`; `reviewDraftWheel` `:2091`–`:2098`; draft-open sites `:1824`, `:2074`; the `<ReviewView>` element `:2453`)
- Test: `tests/reviewView.test.tsx`

**Interfaces:**

- Consumes: `scroll` / `scrollBy` / `onScrollMax` and the `draft:${draftIdx}` key branch (Task 7).
- Produces: `ReviewView` gains required `scroll: number` and optional `onScrollMax?: (max: number) => void`. `DraftOpen` becomes `{ kind: "draft"; draftIdx: number }` — the `scroll` field is gone.

This task is atomic: removing `DraftOpen.scroll` breaks App and the ReviewView tests, so component, App, and tests move in one commit to keep the suite green.

- [ ] **Step 1: Write the failing test**

In `tests/reviewView.test.tsx`, update the four `open: { kind: "draft", draftIdx: 0, scroll: N }` sites (`:114`, `:131`, `:139`, `:158`) to drop the `scroll` field and pass it as a prop instead — e.g. `:131` and `:139` become `state={state({ ...base, open: { kind: "draft", draftIdx: 0 } })} scroll={0}` and `... scroll={1}` respectively; `:114` and `:158` add `scroll={0}`. Then add:

```tsx
it("a past-the-end scroll clamps to the bottom instead of blanking the pane", () => {
  // LONG_DRAFT is 10 lines (line-0..line-9), footer:false. height 10 → rows 8 →
  // bodyRows 6 → max 4, so the bottom window is line-4..line-9.
  const base = { batches: [], drafts: [LONG_DRAFT], cursor: 0 };
  const f = render(
    <ReviewView
      state={state({ ...base, open: { kind: "draft", draftIdx: 0 } })}
      scroll={999}
      height={10}
      focused
    />,
  ).lastFrame()!;
  expect(f).toContain("line-9"); // the last line is on screen…
  expect(f).not.toContain("line-0"); // …and the window stopped at the bottom
});
```

Note `base` at `:127` is scoped inside its own `it` block — the new test declares its own, as above. The existing `scroll={1}` case at `:139` stays valid: 1 ≤ max 4, so it clamps to itself and the top-anchored assertion still holds.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reviewView.test.tsx > /tmp/t9 2>&1; echo "exit: $?"; tail -20 /tmp/t9`

Expected: FAIL — `scroll` is not a `ReviewView` prop and `DraftOpen` still requires `scroll`.

- [ ] **Step 3: Update `ReviewView`**

In `src/tui/components/ReviewView.tsx`, add the import:

```ts
import { clampScroll, maxScroll } from "../window.js";
```

Shrink `DraftOpen`:

```ts
export interface DraftOpen {
  kind: "draft";
  draftIdx: number;
}
```

Add to the props type and destructured list: `scroll: number;` and `onScrollMax?: (max: number) => void;`.

In the draft body, replace `const scroll = state.open.scroll;` with the clamp, and use `start` in the slice and the `key`:

```tsx
// Top-anchored: the window starts exactly at `start`, so `j`/`k` move the
// visible lines by one immediately — no cursor-centering dead-zone.
onScrollMax?.(maxScroll(lines.length, bodyRows));
const start = clampScroll(scroll, lines.length, bodyRows);
```

```tsx
        {lines.slice(start, start + bodyRows).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
```

- [ ] **Step 4: Update App**

Draft key handlers (`:1648`–`:1662`) collapse to the shared recipe — the duplicated `d.draft.split("\n").length - 1` max computation is deleted:

```ts
if (input === "k" || key.upArrow) return void scrollBy(-1);
if (input === "j" || key.downArrow) return void scrollBy(1);
```

`reviewDraftWheel` (`:2091`) becomes a one-liner:

```ts
const reviewDraftWheel = (d: 1 | -1): void => scrollBy(d);
```

Draft-open sites `:1824` and `:2074` drop the field:

```ts
return { ...s, open: { kind: "draft", draftIdx } };
```

The `<ReviewView>` element (`:2453`) gains the two props:

```tsx
<ReviewView
  state={reviewState}
  scroll={scroll}
  height={listHeight}
  focused
  onRowPress={reviewRowPress}
  onFindingPress={reviewFindingPress}
  onDraftWheel={reviewDraftWheel}
  onScrollMax={onScrollMax}
/>
```

If `draft` (`:1646`) is now unused in the draft branch, delete the binding — `npm run lint` fails on unused locals.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/reviewView.test.tsx tests/tuiApp.test.tsx > /tmp/t9 2>&1; echo "exit: $?"; tail -12 /tmp/t9`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui/components/ReviewView.tsx src/tui/App.tsx tests/reviewView.test.tsx
git add src/tui/components/ReviewView.tsx src/tui/App.tsx tests/reviewView.test.tsx
git commit -m "refactor(tui): review draft scrolls via useScroll; drop DraftOpen.scroll"
```

---

### Task 10: Full gate + drive the real TUI

**Files:** none (verification only)

**Interfaces:**

- Consumes: everything above.
- Produces: a green gate.

- [ ] **Step 1: Confirm the three states are actually gone**

Run:

```bash
grep -rn "setScroll\|setLocalScroll\|localScroll" src/tui/ ; echo "hits: $?"
grep -rn "open.scroll\|scroll: 0" src/tui/App.tsx ; echo "hits: $?"
```

Expected: no output from either (`hits: 1`). The only scroll state left in the TUI is inside `useScroll.ts`.

- [ ] **Step 2: Run the full gate**

Run:

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate 2>&1; echo "exit: $?"; tail -15 /tmp/gate
```

Expected: exit 0, ~1,500 tests pass.

- [ ] **Step 3: Drive the real TUI in a sandbox**

The repo doubles as the maintainer's live runtime, and config resolution prefers `./config.json` — never run the dashboard from the repo root. Use a throwaway HOME:

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-3/dist/cli.js config init && \
  HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-3/dist/cli.js dashboard ; \
  cd / && rm -rf "$SB"
```

Open a scrollable surface (`:` → run a command for `CommandOutput`, or `t` for the queue), hold `]` past the end, and confirm: the pane never blanks, the footer counter never exceeds the total, and a single `[` moves the view immediately rather than being absorbed. Press `q` to exit.

If the dashboard cannot reach a daemon in the sandbox, the queue view still renders its loading/empty frame — use the `CommandOutput` surface (`:` → `doctor`) instead, which needs nothing external.

- [ ] **Step 4: Report**

Report the gate's exit code and what the manual drive showed. Do not claim the work is complete without both.

---

## Self-Review

**Spec coverage:**

| Spec item                                                           | Task                                     |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `maxScroll` / `clampScroll` in `window.ts`                          | 1                                        |
| `useScroll(key)` hook, single instance, key resets, both-ends clamp | 2, 7                                     |
| Render clamp on QueueView / CommandOutput / Preview / DaemonSection | 3, 4, 5, 6                               |
| ReviewView draft converges on `total - bodyRows`                    | 9                                        |
| `onScrollMax` reported during render via ref                        | 2 (hook), 3–6, 9 (surfaces)              |
| All 18 manual resets deleted                                        | 7 (14), 8 (4)                            |
| Key derivation table                                                | 7                                        |
| Duplicated `d.draft.split("\n").length - 1` deleted                 | 9                                        |
| Clamp before QueueView's selected-row nudge                         | 3                                        |
| Unit tests beside `windowSlice`                                     | 1                                        |
| Per-component `scroll={999}` tests                                  | 3, 4, 5, 6, 9                            |
| App-level no-dead-input regression                                  | 3 (rewritten queue test), 2 (hook-level) |
| `windowSlice` / cursor lists untouched                              | enforced by Global Constraints           |
| `PrPreview` out of scope                                            | not touched                              |

**Type consistency:** `onScrollMax: (max: number) => void` is spelled identically on the hook (Task 2) and every surface (Tasks 3–6, 9). `scrollBy(d: number)` is the only mutation entry point after Task 7. `ScrollHandle`'s three field names (`scroll`, `scrollBy`, `onScrollMax`) match every consumer.

**Known-hostile tests, addressed:** `tuiApp.test.tsx:2073` (Task 3, Step 4) and `reviewView.test.tsx` ×4 (Task 9, Step 1).
