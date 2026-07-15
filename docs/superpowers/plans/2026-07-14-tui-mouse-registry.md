# TUI Mouse Registry + Hover (Plan A of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full mouse control with hover feedback across every dashboard view (config, palette, queue, review, help, add-repo, LOCAL body, plus the already-covered main/prs/detail views), replacing the mirrored-geometry `hitTest.ts` with a render-time hit-region registry.

**Architecture:** SGR any-motion tracking (`1000;1003;1006`) feeds a `MouseProvider` that resolves pointer events against regions registered by a `<ClickableBox>` drop-in `Box` replacement. Regions self-measure lazily at event time by walking Ink's `yogaNode` layout tree, so rects always match the last committed frame. Hover state lives in a per-region external store (`useSyncExternalStore`) so pointer motion re-renders at most two components.

**Tech Stack:** TypeScript strict/ESM (NodeNext), React 19.2.7 + ink 7.1.0 (exact-pinned), vitest + ink-testing-library 4.0.0.

**Spec:** `docs/superpowers/specs/2026-07-14-tui-mouse-ftue-design.md` (Sections 1–3, 5). Plan B (separate doc) covers the wizard mouse + FTUE + init removal.

## Global Constraints

- Suite green at every commit; conventional commits; **no AI attribution trailers, ever** (amend them away if a tool injects one).
- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- Vitest exit-code trap: never pipe test output through a filter; run `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.
- `npm run typecheck` (NOT `npm run lint` alone) is what type-checks `tests/` — run it after any shared-type change. ~a handful of pre-existing errors in unrelated tests may exist; only NEW errors block.
- Ink/TUI test flake rule: never assert after one fixed `setTimeout` tick; use `until(() => …)` from `tests/helpers/until.js` (bounded retry loop).
- Prettier may reformat between read and edit: re-read before editing, run `npx prettier --write` on touched files before each commit.
- No new dependencies. `node.yogaNode` access is confined to `src/tui/mouseRegions.ts` ONLY.
- ink type facts (verified): `import { type DOMElement } from "ink"` is exported; `DOMElement.parentNode: DOMElement | undefined`; `DOMElement.yogaNode?: YogaNode`; `<Box ref={…}>` accepts `React.Ref<DOMElement>`.
- Branch: `feat/tui-mouse-ftue` (already created off origin/main).

---

### Task 1: `parseMouse` motion events + any-motion protocol strings

**Files:**

- Modify: `src/tui/mouse.ts`
- Test: `tests/tuiMouse.test.ts` (extend existing file)

**Interfaces:**

- Consumes: nothing new.
- Produces: `MOUSE_ENABLE = "[?1000;1003;1006h"`, `MOUSE_DISABLE = "[?1000;1003;1006l"`, `MouseEventKind = "press" | "release" | "wheelUp" | "wheelDown" | "move"`, `parseMouse(data: string): MouseEvent[]` now emitting `move` events. `isMouseInput` unchanged (its regex already matches motion sequences).

- [ ] **Step 1: Write the failing tests** — append to `tests/tuiMouse.test.ts`:

```ts
describe("motion (SGR 1003)", () => {
  it("parses button-less motion (b=35) as a move event", () => {
    expect(parseMouse("[<35;10;5M")).toEqual([{ kind: "move", x: 9, y: 4 }]);
  });

  it("drops drag-motion (left button held, b=32)", () => {
    expect(parseMouse("[<32;10;5M")).toEqual([]);
  });

  it("still parses press/release/wheel alongside moves in one chunk", () => {
    const events = parseMouse("[<35;2;2M[<0;3;3M[<0;3;3m[<64;4;4M");
    expect(events.map((e) => e.kind)).toEqual(["move", "press", "release", "wheelUp"]);
  });

  it("enable/disable strings request 1000+1003+1006", () => {
    expect(MOUSE_ENABLE).toBe("[?1000;1003;1006h");
    expect(MOUSE_DISABLE).toBe("[?1000;1003;1006l");
  });
});
```

(Import `MOUSE_ENABLE`, `MOUSE_DISABLE` in the file's existing import from `../src/tui/mouse.js`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tuiMouse.test.ts`
Expected: FAIL — move parsed as nothing / enable string mismatch.

- [ ] **Step 3: Implement** — in `src/tui/mouse.ts`:

Replace the two protocol constants and the module doc's first paragraph:

```ts
/**
 * SGR mouse protocol (DECSET 1000 click+wheel, 1003 any-motion, 1006 SGR
 * encoding). The dashboard writes MOUSE_ENABLE on mount, parses stdin chunks
 * for `ESC[<b;x;yM|m`, and restores with MOUSE_DISABLE.
 * Reference: xterm ctlseqs "SGR (1006)" / "Any-event tracking (1003)".
 */

export const MOUSE_ENABLE = "[?1000;1003;1006h";
export const MOUSE_DISABLE = "[?1000;1003;1006l";

export type MouseEventKind = "press" | "release" | "wheelUp" | "wheelDown" | "move";
```

Replace the `parseMouse` body's event classification:

```ts
export function parseMouse(data: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of data.matchAll(SGR)) {
    const b = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    if (b & 64) {
      out.push({ kind: (b & 1) === 0 ? "wheelUp" : "wheelDown", x, y });
    } else if (b & 32) {
      // Motion (1003). Button bits 3 = no button held → hover move; a held
      // button (drag, bits 0-2) stays dropped like right/middle clicks.
      if ((b & 3) === 3) out.push({ kind: "move", x, y });
    } else if ((b & 3) === 0) {
      out.push({ kind: m[4] === "M" ? "press" : "release", x, y });
    }
  }
  return out;
}
```

(Also update the function's doc comment: "Left button, wheel, and button-less motion; right/middle and drag-motion are dropped.")

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tuiMouse.test.ts` → PASS. Also `npx vitest run tests/tuiUseMouse.test.tsx tests/tuiMouseApp.test.tsx` — the legacy hook still compiles against the widened union (its handler switch ignores `move`); if a test asserts on the exact enable string, update it to the new constant.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/mouse.ts tests/tuiMouse.test.ts
git add src/tui/mouse.ts tests/tuiMouse.test.ts
git commit -m "feat(tui): parse SGR any-motion mouse events (1003)"
```

---

### Task 2: `mouseRegions.ts` — pure region store + yoga rect walk

**Files:**

- Create: `src/tui/mouseRegions.ts`
- Test: `tests/tuiMouseRegions.test.ts`

**Interfaces:**

- Consumes: nothing (pure module; NO ink import — structural types only, so unit tests need no React).
- Produces (exact, later tasks depend on these):

```ts
export interface YogaNodeLike {
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
}
export interface DOMElementLike {
  yogaNode?: YogaNodeLike;
  parentNode: DOMElementLike | undefined;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RegionHandlers {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
}
export interface ResolvedRegion {
  id: number;
  handlers: RegionHandlers;
}
export interface MouseStore {
  register(
    id: number,
    getNode: () => DOMElementLike | null | undefined,
    handlers: RegionHandlers,
  ): () => void;
  resolve(x: number, y: number, opts?: { needsWheel?: boolean }): ResolvedRegion | null;
  setHoveredFromPoint(x: number, y: number): void;
  hoveredId(): number | null;
  isHovered(id: number): boolean;
  subscribe(id: number, cb: () => void): () => void;
}
export function absoluteRect(node: DOMElementLike): Rect | null;
export function nodeDepth(node: DOMElementLike): number;
export function createMouseStore(): MouseStore;
```

- [ ] **Step 1: Write the failing tests** — `tests/tuiMouseRegions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  absoluteRect,
  nodeDepth,
  createMouseStore,
  type DOMElementLike,
  type YogaNodeLike,
} from "../src/tui/mouseRegions.js";

/** Fake yoga/DOM tree: node at (left,top) within its parent, w×h. */
function yoga(left: number, top: number, width: number, height: number): YogaNodeLike {
  return {
    getComputedLeft: () => left,
    getComputedTop: () => top,
    getComputedWidth: () => width,
    getComputedHeight: () => height,
  };
}
function el(yn: YogaNodeLike | undefined, parent?: DOMElementLike): DOMElementLike {
  return { yogaNode: yn, parentNode: parent };
}

describe("absoluteRect / nodeDepth", () => {
  it("sums offsets up the parent chain (ink render-node-to-output math)", () => {
    const root = el(yoga(0, 0, 80, 24));
    const pane = el(yoga(5, 1, 40, 20), root);
    const row = el(yoga(1, 3, 38, 1), pane);
    expect(absoluteRect(row)).toEqual({ x: 6, y: 4, width: 38, height: 1 });
    expect(nodeDepth(row)).toBe(2);
  });

  it("returns null when the node or an ancestor is detached (no yogaNode)", () => {
    expect(absoluteRect(el(undefined))).toBeNull();
    const detachedParent = el(undefined);
    expect(absoluteRect(el(yoga(0, 0, 5, 1), detachedParent))).toBeNull();
  });
});

describe("createMouseStore", () => {
  const root = el(yoga(0, 0, 80, 24));
  const pane = el(yoga(0, 1, 80, 20), root); // depth 1: rows y 1..20
  const rowA = el(yoga(0, 1, 80, 1), pane); // absolute y=2
  const rowB = el(yoga(0, 2, 80, 1), pane); // absolute y=3

  it("resolve picks the deepest region containing the point", () => {
    const store = createMouseStore();
    store.register(1, () => pane, { onPress: () => {} });
    store.register(2, () => rowA, { onPress: () => {} });
    expect(store.resolve(10, 2)?.id).toBe(2); // row wins over pane
    expect(store.resolve(10, 5)?.id).toBe(1); // pane background
    expect(store.resolve(10, 23)).toBeNull(); // outside both
  });

  it("needsWheel skips regions without onWheel", () => {
    const store = createMouseStore();
    store.register(1, () => pane, { onWheel: () => {} });
    store.register(2, () => rowA, { onPress: () => {} });
    expect(store.resolve(10, 2, { needsWheel: true })?.id).toBe(1);
  });

  it("unregister removes the region; stale/unmounted nodes never match", () => {
    const store = createMouseStore();
    const off = store.register(2, () => rowA, { onPress: () => {} });
    off();
    expect(store.resolve(10, 2)).toBeNull();
    store.register(3, () => undefined, { onPress: () => {} });
    expect(store.resolve(10, 2)).toBeNull();
  });

  it("hover: setHoveredFromPoint notifies ONLY the regions whose state changed", () => {
    const store = createMouseStore();
    store.register(1, () => rowA, { onPress: () => {} });
    store.register(2, () => rowB, { onPress: () => {} });
    const subA = vi.fn();
    const subB = vi.fn();
    store.subscribe(1, subA);
    store.subscribe(2, subB);
    store.setHoveredFromPoint(10, 2); // over rowA
    expect(store.isHovered(1)).toBe(true);
    expect(subA).toHaveBeenCalledTimes(1);
    expect(subB).not.toHaveBeenCalled();
    store.setHoveredFromPoint(11, 2); // still rowA — no change, no notify
    expect(subA).toHaveBeenCalledTimes(1);
    store.setHoveredFromPoint(10, 3); // rowA → rowB: both notified once
    expect(store.isHovered(1)).toBe(false);
    expect(store.isHovered(2)).toBe(true);
    expect(subA).toHaveBeenCalledTimes(2);
    expect(subB).toHaveBeenCalledTimes(1);
    store.setHoveredFromPoint(10, 23); // off everything
    expect(store.hoveredId()).toBeNull();
    expect(subB).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiMouseRegions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/tui/mouseRegions.ts`:

```ts
/**
 * Render-time hit-region registry — the ONLY module allowed to touch ink's
 * semi-internal `yogaNode` (the same accessor ink's own measureElement and
 * render-node-to-output use; ink is exact-pinned at 7.1.0, and this module's
 * tests fail loudly if an upgrade changes the shape). Regions register a
 * lazy node getter; rects are computed AT EVENT TIME by summing
 * getComputedLeft/Top up the parent chain, so they always match the last
 * committed layout — windowed lists and resizes need no special handling.
 * Structural types only (no ink import): unit-testable with fake nodes.
 */

export interface YogaNodeLike {
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
}

export interface DOMElementLike {
  yogaNode?: YogaNodeLike;
  parentNode: DOMElementLike | undefined;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionHandlers {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
}

export interface ResolvedRegion {
  id: number;
  handlers: RegionHandlers;
}

/** Absolute terminal-cell rect, or null for detached/unmounted nodes (a
 * missing yogaNode anywhere in the chain means the element left the tree). */
export function absoluteRect(node: DOMElementLike): Rect | null {
  const yn = node.yogaNode;
  if (!yn) return null;
  let x = yn.getComputedLeft();
  let y = yn.getComputedTop();
  for (let p = node.parentNode; p !== undefined; p = p.parentNode) {
    const pyn = p.yogaNode;
    if (!pyn) return null;
    x += pyn.getComputedLeft();
    y += pyn.getComputedTop();
  }
  return { x, y, width: yn.getComputedWidth(), height: yn.getComputedHeight() };
}

/** Parent-chain length — deeper regions win hit resolution (a row inside a
 * pane outranks the pane's own background region). */
export function nodeDepth(node: DOMElementLike): number {
  let d = 0;
  for (let p = node.parentNode; p !== undefined; p = p.parentNode) d++;
  return d;
}

interface Region {
  id: number;
  getNode: () => DOMElementLike | null | undefined;
  handlers: RegionHandlers;
}

export interface MouseStore {
  register(
    id: number,
    getNode: () => DOMElementLike | null | undefined,
    handlers: RegionHandlers,
  ): () => void;
  resolve(x: number, y: number, opts?: { needsWheel?: boolean }): ResolvedRegion | null;
  setHoveredFromPoint(x: number, y: number): void;
  hoveredId(): number | null;
  isHovered(id: number): boolean;
  subscribe(id: number, cb: () => void): () => void;
}

export function createMouseStore(): MouseStore {
  const regions = new Map<number, Region>();
  const subscribers = new Map<number, Set<() => void>>();
  let hovered: number | null = null;

  const notify = (id: number): void => {
    for (const cb of subscribers.get(id) ?? []) cb();
  };

  const resolve = (
    x: number,
    y: number,
    opts?: { needsWheel?: boolean },
  ): ResolvedRegion | null => {
    let best: Region | null = null;
    let bestDepth = -1;
    for (const r of regions.values()) {
      if (opts?.needsWheel && !r.handlers.onWheel) continue;
      const node = r.getNode();
      if (!node) continue;
      const rect = absoluteRect(node);
      if (!rect) continue;
      if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) {
        continue;
      }
      const depth = nodeDepth(node);
      // Ties (same depth): later registration wins — children register after
      // parents within one commit, and re-registrations replace in place.
      if (depth >= bestDepth) {
        best = r;
        bestDepth = depth;
      }
    }
    return best ? { id: best.id, handlers: best.handlers } : null;
  };

  return {
    register(id, getNode, handlers) {
      regions.set(id, { id, getNode, handlers });
      return () => {
        regions.delete(id);
        if (hovered === id) {
          hovered = null;
          notify(id);
        }
      };
    },
    resolve,
    setHoveredFromPoint(x, y) {
      const next = resolve(x, y)?.id ?? null;
      if (next === hovered) return;
      const prev = hovered;
      hovered = next;
      if (prev !== null) notify(prev);
      if (next !== null) notify(next);
    },
    hoveredId: () => hovered,
    isHovered: (id) => hovered === id,
    subscribe(id, cb) {
      let set = subscribers.get(id);
      if (!set) {
        set = new Set();
        subscribers.set(id, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/tuiMouseRegions.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/mouseRegions.ts tests/tuiMouseRegions.test.ts
git add src/tui/mouseRegions.ts tests/tuiMouseRegions.test.ts
git commit -m "feat(tui): pure mouse hit-region store with yoga rect resolution"
```

---

### Task 3: `MouseProvider` + `ClickableBox` + `theme.hoverBg`

**Files:**

- Create: `src/tui/MouseProvider.tsx`
- Create: `src/tui/ClickableBox.tsx`
- Modify: `src/tui/theme.ts` (add `hoverBg`)
- Test: `tests/tuiClickable.test.tsx`

**Interfaces:**

- Consumes: Task 1 (`MOUSE_ENABLE/DISABLE`, `parseMouse`), Task 2 (`createMouseStore`, `MouseStore`, `RegionHandlers`, `DOMElementLike`).
- Produces (exact):

```ts
// MouseProvider.tsx
export interface MouseContextValue {
  store: MouseStore;
  missRef: React.MutableRefObject<(() => void) | null>;
  pressObserverRef: React.MutableRefObject<(() => void) | null>;
}
export const MouseContext: React.Context<MouseContextValue | null>;
export function MouseProvider({ children }: { children: React.ReactNode }): React.JSX.Element;
export function useOnMouseMiss(fn: (() => void) | null): void;   // press hit no region
export function useOnAnyMousePress(fn: (() => void) | null): void; // every press, before dispatch

// ClickableBox.tsx
export type ClickableBoxProps = React.ComponentProps<typeof Box> & {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
  hoverBg?: string; // backgroundColor while hovered (falls back to backgroundColor)
  children?: React.ReactNode | ((hovered: boolean) => React.ReactNode);
};
export function ClickableBox(props: ClickableBoxProps): React.JSX.Element;

// theme.ts addition
hoverBg: "#20242f",  // one step dimmer than selectionBg — hover must not outshine selection
```

- [ ] **Step 1: Write the failing tests** — `tests/tuiClickable.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { MouseProvider, useOnMouseMiss, useOnAnyMousePress } from "../src/tui/MouseProvider.js";
import { ClickableBox } from "../src/tui/ClickableBox.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const press = (x: number, y: number) => `[<0;${x + 1};${y + 1}M`;
const move = (x: number, y: number) => `[<35;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number) => `[<65;${x + 1};${y + 1}M`;

function Rows({
  onA,
  onB,
  onWheel,
}: {
  onA: () => void;
  onB: () => void;
  onWheel?: (d: 1 | -1) => void;
}) {
  return (
    <MouseProvider>
      <ClickableBox onWheel={onWheel} flexDirection="column">
        <ClickableBox onPress={onA}>
          {(hovered) => <Text>{hovered ? "A*" : "A"}</Text>}
        </ClickableBox>
        <ClickableBox onPress={onB}>
          <Text>B</Text>
        </ClickableBox>
      </ClickableBox>
    </MouseProvider>
  );
}

describe("ClickableBox + MouseProvider", () => {
  it("press dispatches to the row under the pointer (deepest region)", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const r = render(<Rows onA={onA} onB={onB} />);
    await until(() => (r.lastFrame() ?? "").includes("B"));
    r.stdin.write(press(0, 0));
    await until(() => onA.mock.calls.length === 1);
    r.stdin.write(press(0, 1));
    await until(() => onB.mock.calls.length === 1);
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("wheel bubbles to the nearest ancestor with onWheel", async () => {
    const onWheel = vi.fn();
    const r = render(<Rows onA={() => {}} onB={() => {}} onWheel={onWheel} />);
    await until(() => (r.lastFrame() ?? "").includes("B"));
    r.stdin.write(wheelDown(0, 0)); // over row A, which has no onWheel
    await until(() => onWheel.mock.calls.length === 1);
    expect(onWheel).toHaveBeenCalledWith(1);
  });

  it("hover: render-prop children see the hover flag flip", async () => {
    const r = render(<Rows onA={() => {}} onB={() => {}} />);
    await until(() => (r.lastFrame() ?? "").includes("A"));
    r.stdin.write(move(0, 0));
    await until(() => (r.lastFrame() ?? "").includes("A*"));
    r.stdin.write(move(0, 1));
    await until(() => !(r.lastFrame() ?? "").includes("A*"));
  });

  it("miss handler fires on a press outside every region; press observer fires on every press", async () => {
    const onMiss = vi.fn();
    const onAny = vi.fn();
    function App() {
      useOnMouseMiss(onMiss);
      useOnAnyMousePress(onAny);
      return (
        <ClickableBox onPress={() => {}}>
          <Text>hit</Text>
        </ClickableBox>
      );
    }
    const r = render(
      <MouseProvider>
        <App />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("hit"));
    r.stdin.write(press(0, 0)); // on the region
    r.stdin.write(press(50, 10)); // off it
    await until(() => onMiss.mock.calls.length === 1);
    expect(onAny).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiClickable.test.tsx` → FAIL (modules not found).

- [ ] **Step 3: Implement.**

`src/tui/theme.ts` — add to the `theme` object after `selectionBg`:

```ts
  hoverBg: "#20242f",
```

`src/tui/MouseProvider.tsx`:

```tsx
/**
 * App-root mouse pipeline: enables SGR any-motion reporting for the app's
 * lifetime (restored on unmount AND process exit), parses stdin chunks, and
 * dispatches against the hit-region store. Motion is coalesced per chunk
 * (last position wins) and hover updates notify only the affected regions —
 * pointer motion that changes nothing re-renders nothing.
 */
import React, { createContext, useContext, useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE, parseMouse, type MouseEvent } from "./mouse.js";
import { createMouseStore, type MouseStore } from "./mouseRegions.js";

export interface MouseContextValue {
  store: MouseStore;
  /** A press that hit NO region (modal views map this to esc/cancel). */
  missRef: React.MutableRefObject<(() => void) | null>;
  /** Every press, before dispatch — the toast-dismiss parity hook. */
  pressObserverRef: React.MutableRefObject<(() => void) | null>;
}

export const MouseContext = createContext<MouseContextValue | null>(null);

export function MouseProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const storeRef = useRef<MouseStore | null>(null);
  storeRef.current ??= createMouseStore();
  const store = storeRef.current;
  const missRef = useRef<(() => void) | null>(null);
  const pressObserverRef = useRef<(() => void) | null>(null);
  const ctxRef = useRef<MouseContextValue | null>(null);
  ctxRef.current ??= { store, missRef, pressObserverRef };
  const { stdin } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    stdout.write(MOUSE_ENABLE);
    const onData = (data: unknown): void => {
      let lastMove: MouseEvent | null = null;
      for (const ev of parseMouse(String(data))) {
        if (ev.kind === "move") {
          lastMove = ev; // coalesce: only the final position this chunk matters
        } else if (ev.kind === "press") {
          pressObserverRef.current?.();
          const hit = store.resolve(ev.x, ev.y);
          if (hit?.handlers.onPress) hit.handlers.onPress();
          else missRef.current?.();
        } else if (ev.kind === "wheelUp" || ev.kind === "wheelDown") {
          const hit = store.resolve(ev.x, ev.y, { needsWheel: true });
          hit?.handlers.onWheel?.(ev.kind === "wheelDown" ? 1 : -1);
        }
        // "release": press-activated UI — parsed, nothing to do.
      }
      if (lastMove) store.setHoveredFromPoint(lastMove.x, lastMove.y);
    };
    stdin.on("data", onData);
    const restore = (): void => {
      stdout.write(MOUSE_DISABLE);
    };
    process.on("exit", restore);
    return () => {
      stdin.off("data", onData);
      process.off("exit", restore);
      restore();
    };
  }, [stdin, stdout, store]);

  return <MouseContext.Provider value={ctxRef.current}>{children}</MouseContext.Provider>;
}

/** Register the active "press hit nothing" handler (last mounted wins; null
 * clears). The App swaps this per view — modal views map it to esc/cancel. */
export function useOnMouseMiss(fn: (() => void) | null): void {
  const ctx = useContext(MouseContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.missRef.current = fn;
    return () => {
      ctx.missRef.current = null;
    };
  }, [ctx, fn]);
}

/** Observe every press before dispatch (toast dismissal parity with keys). */
export function useOnAnyMousePress(fn: (() => void) | null): void {
  const ctx = useContext(MouseContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.pressObserverRef.current = fn;
    return () => {
      ctx.pressObserverRef.current = null;
    };
  }, [ctx, fn]);
}
```

`src/tui/ClickableBox.tsx`:

```tsx
/**
 * Drop-in Box replacement that makes its rectangle a mouse target: onPress,
 * onWheel, hover styling (hoverBg or a render-prop `hovered` flag). Without a
 * MouseProvider above it (bare component tests), it renders as a plain Box.
 * Handlers live in a ref — re-renders never re-register the region.
 */
import React, { useContext, useEffect, useRef, useSyncExternalStore, useCallback } from "react";
import { Box, type DOMElement } from "ink";
import { MouseContext } from "./MouseProvider.js";

let nextRegionId = 1;

export type ClickableBoxProps = React.ComponentProps<typeof Box> & {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
  hoverBg?: string;
  children?: React.ReactNode | ((hovered: boolean) => React.ReactNode);
};

export function ClickableBox({
  onPress,
  onWheel,
  hoverBg,
  children,
  ...boxProps
}: ClickableBoxProps): React.JSX.Element {
  const ctx = useContext(MouseContext);
  const store = ctx?.store ?? null;
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = nextRegionId++;
  const id = idRef.current;
  const ref = useRef<DOMElement | null>(null);
  const handlersRef = useRef<{ onPress?: () => void; onWheel?: (d: 1 | -1) => void }>({});
  handlersRef.current = { onPress, onWheel };
  // Wheel resolution filters on handler presence, so only register the keys
  // that exist THIS render (a ref-stable trampoline would advertise onWheel
  // even when the prop is absent).
  const hasPress = onPress !== undefined;
  const hasWheel = onWheel !== undefined;

  useEffect(() => {
    if (!store) return;
    return store.register(id, () => ref.current, {
      onPress: hasPress ? () => handlersRef.current.onPress?.() : undefined,
      onWheel: hasWheel ? (d) => handlersRef.current.onWheel?.(d) : undefined,
    });
  }, [store, id, hasPress, hasWheel]);

  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(id, cb) : () => {}),
    [store, id],
  );
  const hovered = useSyncExternalStore(subscribe, () => (store ? store.isHovered(id) : false));

  const bg = hovered && hoverBg !== undefined ? hoverBg : boxProps.backgroundColor;
  return (
    <Box ref={ref} {...boxProps} backgroundColor={bg}>
      {typeof children === "function" ? children(hovered) : children}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/tuiClickable.test.tsx tests/tuiMouseRegions.test.ts` → PASS. Then `npm run typecheck` (new tsx files enter the eslint tsconfig).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/MouseProvider.tsx src/tui/ClickableBox.tsx src/tui/theme.ts tests/tuiClickable.test.tsx
git add src/tui/MouseProvider.tsx src/tui/ClickableBox.tsx src/tui/theme.ts tests/tuiClickable.test.tsx
git commit -m "feat(tui): MouseProvider dispatch + ClickableBox hover regions"
```

---

### Task 4: `useGuardedInput` + sweep every `useInput` caller

**Files:**

- Create: `src/tui/useGuardedInput.ts`
- Modify: every `useInput` caller under `src/tui/` (enumerate with the grep below; as of this plan: `App.tsx`, `components/ConfigView.tsx`, `components/TextField.tsx`, `components/AddRepoForm.tsx`, `wizard/WizardApp.tsx`, `wizard/controls.tsx` (Select + MultiSelect), `wizard/chapters/*.tsx`)
- Test: `tests/tuiGuardedInput.test.tsx`

**Interfaces:**

- Consumes: `isMouseInput` (Task 1 module, unchanged).
- Produces: `useGuardedInput(handler: (input: string, key: Key) => void, options?: { isActive?: boolean }): void` where `Key` is ink's `Key` type.

- [ ] **Step 1: Write the failing test** — `tests/tuiGuardedInput.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { useGuardedInput } from "../src/tui/useGuardedInput.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

describe("useGuardedInput", () => {
  it("drops leaked SGR mouse sequences, passes real keys through", async () => {
    const seen: string[] = [];
    function Probe() {
      useGuardedInput((input) => {
        seen.push(input);
      });
      return <Text>probe</Text>;
    }
    const r = render(<Probe />);
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    // Ink strips the ESC from CSI sequences before handing them to useInput,
    // so a leaked mouse event arrives as "[<35;5;5M".
    r.stdin.write("[<35;5;5M");
    r.stdin.write("x");
    await until(() => seen.length > 0);
    expect(seen).toEqual(["x"]);
  });

  it("honors isActive", async () => {
    const spy = vi.fn();
    function Probe() {
      useGuardedInput(spy, { isActive: false });
      return <Text>probe</Text>;
    }
    const r = render(<Probe />);
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    r.stdin.write("x");
    await new Promise((res) => setTimeout(res, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiGuardedInput.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — `src/tui/useGuardedInput.ts`:

```ts
/**
 * useInput minus leaked mouse CSI: with reporting enabled, ink parses each
 * SGR sequence as one keypress and hands "[<b;x;yM" to every handler. This
 * wrapper is the ONE place that drops them — every TUI input handler goes
 * through it (convention; MouseProvider owns the real events via stdin).
 */
import { useInput, type Key } from "ink";
import { isMouseInput } from "./mouse.js";

export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options?: { isActive?: boolean },
): void {
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    handler(input, key);
  }, options);
}
```

- [ ] **Step 4: Sweep.** Enumerate callers:

Run: `grep -rln "useInput" src/tui`

For EACH file: replace `useInput(` calls with `useGuardedInput(`, import from the correct relative path (`./useGuardedInput.js` from `src/tui/`, `../useGuardedInput.js` from `components/` and `wizard/`, `../../useGuardedInput.js` from `wizard/chapters/`), delete the now-redundant leading `if (isMouseInput(input)) return;` line inside each handler, and drop unused `isMouseInput` / `useInput` imports. `AddRepoForm.tsx` has no isMouseInput guard today — converting it FIXES a latent leak. Files whose useInput import is only a type reference (`Parameters<typeof useInput>` in App.tsx's `handleLocalInput` signature) keep that type import: change the signature to `(input: string, key: Key)` with `import { type Key } from "ink"` instead.

- [ ] **Step 5: Verify** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` (full suite; the wizard + TUI suites exercise every converted handler). Expected: exit 0. Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui tests/tuiGuardedInput.test.tsx
git add -A src/tui tests/tuiGuardedInput.test.tsx
git commit -m "refactor(tui): centralize mouse-CSI guard in useGuardedInput"
```

---

### Task 5: Mount MouseProvider; migrate header mode tabs to regions

**Files:**

- Modify: `src/dashboardCmd.ts` (wrap App in MouseProvider)
- Modify: `src/tui/components/Chrome.tsx` (Header gains `onModeTab`)
- Modify: `src/tui/App.tsx` (pass `onModeTab`; delete the `ev.y === 0` branch from `onMouseEvent`)
- Modify: `tests/helpers/localFixtures.ts` (renderApp must wrap in MouseProvider)
- Test: `tests/tuiMouseApp.test.tsx` (header test now goes through regions)

**Interfaces:**

- Consumes: `MouseProvider`, `ClickableBox`, `theme.hoverBg`.
- Produces: `Header` prop `onModeTab?: (m: UiMode) => void`; App helper `handleModeTab(m: UiMode): void` (also reused by Task 10's footer actions).

Coexistence note: the legacy `useMouse`/`hitTest` path stays alive for rows until Task 6; both it and MouseProvider parse the same stdin (harmless duplication for one task). Deleting the `ev.y === 0` branch in the SAME commit that adds tab regions prevents double-firing.

- [ ] **Step 1: Update the header test** in `tests/tuiMouseApp.test.tsx` — the existing "header-band click still toggles the mode" test stays byte-identical in intent; add a hover assertion:

```tsx
it("hovering a header tab does not crash and hover moves with the pointer", async () => {
  const r = renderApp({ initialUiMode: "github" });
  await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
  r.stdin.write(`[<35;${headerTabBands(WIDE_COLS_TEST).localStart + 1};1M`);
  await until(() => (r.lastFrame() ?? "") !== ""); // hover styling is cosmetic — frame stays renderable
  r.stdin.write(press(headerTabBands(WIDE_COLS_TEST).localStart, 0));
  await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
});
```

- [ ] **Step 2: Run to verify failure mode** — `npx vitest run tests/tuiMouseApp.test.tsx`. The click test passes via the LEGACY path pre-change; proceed (this task's assertion of success is that it still passes AFTER the migration).

- [ ] **Step 3: Implement.**

`src/dashboardCmd.ts` — add `MouseProvider` to the parallel dynamic imports and wrap:

```ts
const [
  { App },
  { MouseProvider },
  { makeGhDashboardClient },
  { watchlistPath },
  { makeQueueSnapshotFn },
  { makeLocalCheapFn, makeLocalHeavyFn },
  react,
  ink,
] = await Promise.all([
  import("./tui/App.js"),
  import("./tui/MouseProvider.js"),
  import("./tui/ghClient.js"),
  import("./watchlist.js"),
  import("./tui/queueSnapshot.js"),
  import("./tui/localSnapshot.js"),
  import("react"),
  import("ink"),
]);
```

and where the element is built:

```ts
const instance = renderFn(
  react.createElement(
    MouseProvider,
    null,
    react.createElement(App, {
      /* …existing props unchanged… */
    }),
  ),
);
```

`tests/helpers/localFixtures.ts` — wrap the element `renderApp` renders in `<MouseProvider>…</MouseProvider>` (import from `../../src/tui/MouseProvider.js`) so every App-level test exercises the real pipeline.

`src/tui/components/Chrome.tsx` — Header signature gains `onModeTab`:

```ts
  /** Click handler for the GITHUB/LOCAL tabs (region-based; Task 5). */
  onModeTab?: (m: UiMode) => void;
```

and the tab segment render becomes:

```tsx
{
  uiMode !== undefined && (
    <Box flexShrink={0}>
      <ClickableBox
        onPress={onModeTab ? () => onModeTab("github") : undefined}
        hoverBg={theme.hoverBg}
      >
        <Text
          color={uiMode === "github" ? theme.accent : undefined}
          bold={uiMode === "github"}
          dimColor={githubEnabled === false}
        >
          {ghLabel}
        </Text>
      </ClickableBox>
      <Text> </Text>
      <ClickableBox
        onPress={onModeTab ? () => onModeTab("local") : undefined}
        hoverBg={theme.hoverBg}
      >
        <Text color={uiMode === "local" ? theme.accent : undefined} bold={uiMode === "local"}>
          {loLabel}
        </Text>
      </ClickableBox>
    </Box>
  );
}
```

(import `ClickableBox` from `../ClickableBox.js`; the fixed-width padEnd labels are unchanged, so geometry stays byte-stable.)

`src/tui/App.tsx` — add next to `canToggleMode`:

```ts
// Region-based tab clicks (Header). Guarded like the `m` key: inert while
// the confirm modal owns input; github-disabled taps toast instead of switch.
const handleModeTab = (m: UiMode): void => {
  if (confirm !== null) return;
  if (m === uiMode) return;
  if (m === "github" && !props.githubEnabled) {
    dismissToast();
    showToast("info", "github mode is off ([github] enabled=false)");
    return;
  }
  dismissToast();
  setUiMode(m);
};
```

pass `onModeTab={handleModeTab}` where `<Header …>` is rendered, and DELETE the whole `if (ev.y === 0 && ev.kind === "press") { … }` block from `onMouseEvent` (the legacy path must not double-fire).

- [ ] **Step 4: Verify** — `npx vitest run tests/tuiMouseApp.test.tsx tests/tuiApp.test.tsx tests/tuiChrome.test.tsx tests/tuiLocalApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0. Then the full suite once.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/dashboardCmd.ts src/tui/components/Chrome.tsx src/tui/App.tsx tests/helpers/localFixtures.ts tests/tuiMouseApp.test.tsx
git add -A
git commit -m "feat(tui): region-based header mode tabs behind MouseProvider"
```

---

### Task 6: Migrate main/prs/detail/queue/cmdOutput to regions; retire hitTest/useMouse

**Files:**

- Modify: `src/tui/components/Rail.tsx`, `IssueList.tsx`, `PrList.tsx`, `Preview.tsx`, `PrPreview.tsx`
- Modify: `src/tui/App.tsx` (handler wiring; delete `onMouseEvent`, `useMouse` call, `hitTest` import)
- Delete: `src/tui/hitTest.ts`, `src/tui/useMouse.ts`, `tests/tuiHitTest.test.ts`, `tests/tuiUseMouse.test.tsx`
- Modify: `src/tui/geometry.ts` (delete `headerTabBands` + `TAB_BRAND_COLS`; keep the row-budget helpers — they are render math), `src/tui/components/Chrome.tsx` (Header keeps its own local `ghWidth/loWidth` constants; drop the geometry mirror comment), `tests/tuiGeometry.test.ts` (drop headerTabBands cases)
- Test: `tests/tuiMouseApp.test.tsx` (row-click/wheel specs), `tests/tuiIssueList.test.tsx`/`tests/tuiRail.test.tsx`/`tests/tuiPrList.test.tsx` (props compile — no behavioral change unless handlers passed)

**Interfaces:**

- Consumes: `ClickableBox`, `useOnAnyMousePress`, `theme.hoverBg`.
- Produces (exact new component props — all optional so existing tests compile):
  - `Rail`: `onRowPress?: (index: number) => void; onPanePress?: () => void; onWheel?: (dir: 1 | -1) => void`
  - `IssueList`: `onRowPress?: (index: number) => void; onPanePress?: () => void; onWheel?: (dir: 1 | -1) => void`
  - `PrList`: `onRowPress?: (index: number) => void; onPanePress?: () => void; onWheel?: (dir: 1 | -1) => void`
  - `Preview`: `onLinkPress?: () => void; onWheel?: (dir: 1 | -1) => void`
  - `PrPreview`: `onLinkPress?: () => void`

- [ ] **Step 1: Write failing tests** — replace the LOCAL no-op body test in `tests/tuiMouseApp.test.tsx` with GITHUB-mode row specs (the LOCAL body becomes interactive in Task 9, which brings its own tests). Use the frame to locate rows instead of hardcoding y:

```tsx
const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

it("clicking an issue row selects it; clicking again opens the detail", async () => {
  const r = renderApp({ initialUiMode: "github" }); // fixture provides ≥2 issues
  await until(() => lineOf(r.lastFrame() ?? "", "#2") >= 0);
  const y = lineOf(r.lastFrame() ?? "", "#2");
  const x = WIDE_COLS_TEST - 40; // middle column band — inside pane 2
  r.stdin.write(press(x, y));
  await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("▌"));
  r.stdin.write(press(x, y));
  await until(() => (r.lastFrame() ?? "").includes("preview · #2"));
});

it("wheel over the rail moves the repo selection", async () => {
  const r = renderApp({ initialUiMode: "github" }); // fixture provides ≥2 repos
  await until(() => (r.lastFrame() ?? "").includes("1 repos"));
  r.stdin.write("[<65;3;5M"); // wheelDown inside the rail band
  await until(() => {
    const f = r.lastFrame() ?? "";
    const second = lineOf(f, /* second repo nwo from the fixture */ "beta/two");
    return second >= 0 && f.split("\n")[second].includes("▌");
  });
});
```

Adapt fixture names to `tests/helpers/localFixtures.ts` (read it; if its `renderApp` seeds fewer than 2 issues/repos, extend the fixture data — additive only).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiMouseApp.test.tsx` → new specs FAIL (legacy path still routes but detail-on-second-click semantics only work while `onMouseEvent` exists — after Step 3 they pass through regions).

- [ ] **Step 3: Component edits.** Pattern (shown for Rail; apply the SAME transform to IssueList rows and PrList rows with their own key/index variables):

`Rail.tsx` — add to `RailProps`:

```ts
  onRowPress?: (index: number) => void;
  onPanePress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
```

Root `<Box …>` of the component becomes `<ClickableBox … onPress={onPanePress} onWheel={onWheel}>` (same style props; import `ClickableBox` from `../ClickableBox.js`). The repo row becomes:

```tsx
return (
  <ClickableBox
    key={r.nwo}
    width="100%"
    backgroundColor={sel ? theme.selectionBg : undefined}
    hoverBg={sel ? theme.selectionBg : theme.hoverBg}
    onPress={onRowPress ? () => onRowPress(idx) : undefined}
  >
    <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
    <Text wrap="truncate">
      {r.nwo}
      {r.fromConfig ? " (cfg)" : ""}
      {badges ? `  ${badges}` : ""}
    </Text>
  </ClickableBox>
);
```

`IssueList.tsx` — same three props; root Box → ClickableBox with `onPress={onPanePress}` + `onWheel`; the issue row Box (`key={iss.number}`) → ClickableBox with `hoverBg={sel ? theme.selectionBg : theme.hoverBg}` and `onPress={onRowPress ? () => onRowPress(idx) : undefined}`.

`PrList.tsx` — same three props; root Box → ClickableBox (`onPanePress`/`onWheel`); the PR row Box (`key={`${prItem.nwo}#${prItem.number}`}`) → ClickableBox with the same hoverBg rule and `onPress={onRowPress ? () => onRowPress(idx) : undefined}`.

`Preview.tsx` — add `onLinkPress?: () => void; onWheel?: (dir: 1 | -1) => void` to props; root Box → ClickableBox with `onWheel`; wrap the ↗ line:

```tsx
<ClickableBox onPress={onLinkPress} hoverBg={theme.hoverBg}>
  <Transform transform={(s) => hyperlink(s, issue.url)}>
    <Text dimColor wrap="truncate">
      ↗ {shortResourceRef(issue.url)}
    </Text>
  </Transform>
</ClickableBox>
```

`PrPreview.tsx` — add `onLinkPress?: () => void`; the `key="link"` Transform row in the `rows` array becomes:

```tsx
<ClickableBox key="link" onPress={onLinkPress} hoverBg={theme.hoverBg}>
  <Transform transform={(s) => hyperlink(s, pr.url)}>
    <Text dimColor wrap="truncate">
      ↗ {pr.nwo}#{pr.number}
    </Text>
  </Transform>
</ClickableBox>
```

- [ ] **Step 4: App wiring.** In `src/tui/App.tsx`:

Add `useOnAnyMousePress(dismissToast);` near the other hooks (import from `./MouseProvider.js`) — press-dismisses toasts app-wide (parity with the old `dismissToast()` on press; the old code skipped LOCAL, the new one covers it — deliberate improvement).

Pass handlers at the render sites (all in the `Workspace` children tail):

```tsx
<Rail
  /* …existing props… */
  onRowPress={(i) => {
    if (confirm !== null || view !== "main") return;
    setPane(1);
    setRepoIdx(i);
  }}
  onPanePress={view === "main" && confirm === null ? () => setPane(1) : undefined}
  onWheel={(d) =>
    view === "main"
      ? setRepoIdx((i) => Math.max(0, Math.min(i + d, repoMappings.length - 1)))
      : undefined
  }
/>
```

```tsx
<IssueList
  /* …existing props… */
  onRowPress={(i) => {
    if (confirm !== null) return;
    if (pane === 2 && i === issueIdxSafe) return void openDetail();
    setPane(2);
    moveIssueTo(i);
  }}
  onPanePress={confirm === null ? () => setPane(2) : undefined}
  onWheel={(d) => moveIssue(d)}
/>
```

prs-view `PrList`:

```tsx
<PrList
  /* …existing props… */
  onRowPress={(i) => {
    if (confirm !== null) return;
    if (i === prIdxSafe) return void openPrDetail(selectedPr, "prs");
    movePrTo(i);
  }}
  onWheel={(d) => movePr(d)}
/>
```

pane-3 `PrList` (inside the wide-mode right band):

```tsx
<PrList
  /* …existing props… */
  onRowPress={(i) => {
    if (confirm !== null) return;
    if (pane === 3 && i === pane3IdxSafe) {
      return void openPrDetail(selectedPane3Pr, "main");
    }
    setPane(3);
    movePane3To(i);
  }}
  onPanePress={confirm === null ? () => setPane(3) : undefined}
  onWheel={(d) => movePane3(d)}
/>
```

detail `Preview`: `onLinkPress={openDetailIssueInBrowser}` and `onWheel={(d) => setScroll((s) => Math.max(0, s + d))}`.
prDetail `PrPreview`: `onLinkPress={openPrDetailInBrowser}`.
prs-view right-band `PrPreview`: `onLinkPress={selectedPr ? openSelectedPr : undefined}`.

queue + cmdOutput wheel (these components stay untouched — wrap at the call site):

```tsx
          ) : view === "queue" ? (
            <ClickableBox flexGrow={1} onWheel={(d) => setScroll((s) => Math.max(0, s + d))}>
              <QueueView snap={queueSnap} scroll={scroll} now={queueNow} height={listHeight} focused />
            </ClickableBox>
          ) : view === "cmdOutput" && cmd ? (
            <ClickableBox flexGrow={1} onWheel={(d) => setScroll((s) => Math.max(0, s + d))}>
              <CommandOutput /* …existing props… */ />
            </ClickableBox>
```

Then DELETE: the entire `onMouseEvent` function, the `useMouse(onMouseEvent)` call and import, the `hitTest`/`HitContext` import, and the now-unused `headerTabBands` import.

- [ ] **Step 5: Retire the legacy modules.**

```bash
git rm src/tui/hitTest.ts src/tui/useMouse.ts tests/tuiHitTest.test.ts tests/tuiUseMouse.test.tsx
```

In `src/tui/geometry.ts` delete `headerTabBands` and `TAB_BRAND_COLS` (keep `QUEUE_CARD_ROWS`, `PANE_CONTENT_ROW`, `LINK_LINE_ROW` comment-docs IF still referenced — grep first: `grep -rn "LINK_LINE_ROW\|PANE_CONTENT_ROW\|railListHeight\|listRowsHeight" src tests` — the row-budget helpers ARE used by App windowing and LocalDashboard; delete only what has zero remaining references). In `Chrome.tsx` Header, keep the tab width logic as local constants and rewrite its comment to note the widths are now purely presentational. `tests/tuiMouseApp.test.tsx` still imports `headerTabBands` for click coordinates — inline the two starting columns as fixture constants computed the same way (`TAB_BRAND_COLS` was 11; github tab at x=11, local at x=11+8+1=20 in wide mode) with a comment tying them to Header's padEnd widths. Update `tests/tuiGeometry.test.ts` (drop headerTabBands describe block).

- [ ] **Step 6: Verify** — full suite: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0; fix fallout (tests that imported the deleted modules). Then `npm run typecheck && npm run build`.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/tui tests
git add -A
git commit -m "feat(tui): migrate dashboard surfaces to hit-region registry, retire hitTest/useMouse"
```

---

### Task 7: Modal surfaces — help/palette/addRepo clicks + miss routing

**Files:**

- Modify: `src/tui/App.tsx` (per-view `useOnMouseMiss`), `src/tui/components/CommandPalette.tsx`, `src/tui/components/AddRepoForm.tsx`
- Test: `tests/tuiPalette.test.tsx` (extend), `tests/tuiMouseApp.test.tsx` (help/addRepo miss specs)

**Interfaces:**

- Consumes: `useOnMouseMiss`, `ClickableBox`.
- Produces: `CommandPalette` prop `onRowPress?: (index: number) => void`.

- [ ] **Step 1: Failing tests.**

`tests/tuiMouseApp.test.tsx`:

```tsx
it("help modal: any click closes it", async () => {
  const r = renderApp({ initialUiMode: "github" });
  await until(() => (r.lastFrame() ?? "").includes("1 repos"));
  r.stdin.write("?");
  await until(() => (r.lastFrame() ?? "").includes("junco dashboard"));
  r.stdin.write(press(2, 2)); // anywhere — HelpModal registers no regions
  await until(() => !(r.lastFrame() ?? "").includes("junco dashboard — "));
});

it("addRepo modal: click outside cancels back to main", async () => {
  const r = renderApp({ initialUiMode: "github" });
  await until(() => (r.lastFrame() ?? "").includes("1 repos"));
  r.stdin.write("w");
  await until(() => (r.lastFrame() ?? "").includes("add repo to watchlist"));
  r.stdin.write(press(0, 5)); // far left — outside the centered modal box
  await until(() => !(r.lastFrame() ?? "").includes("add repo to watchlist"));
});
```

`tests/tuiPalette.test.tsx` — add a spec: render the palette (via the existing fixture path used in that file), click a visible command row → selection moves; click it again → the command runs (assert on the fixture's `runCliFn` spy).

- [ ] **Step 2: Run to verify failure** — the help/addRepo specs fail (clicks are dead in modal views today).

- [ ] **Step 3: Implement.**

`App.tsx` — one memoized miss handler; place near `handleModeTab`:

```tsx
// A press that hit no region. Modal-ish views read it as esc/cancel; the
// confirm modal deliberately IGNORES it (destructive confirmation stays
// keyboard-only). Everything else: no-op.
const onMouseMiss = useMemo(() => {
  if (confirm !== null) return null;
  if (view === "help") return () => setView("main");
  if (view === "palette") return () => setView("main");
  if (view === "addRepo") return () => setView("main");
  return null;
}, [confirm, view]);
useOnMouseMiss(onMouseMiss);
```

(`useMemo` import; `useOnMouseMiss` from `./MouseProvider.js`. Note `setView("main")` matches the keyboard esc for each of these views; addRepo's esc path is `onCancel: () => setView("main")` — identical.)

`CommandPalette.tsx` — add `onRowPress?: (index: number) => void` to props; the command row Box (`key={c.name}`) becomes:

```tsx
<ClickableBox
  key={c.name}
  gap={1}
  hoverBg={theme.hoverBg}
  onPress={onRowPress ? () => onRowPress(i) : undefined}
>
  {/* …unchanged row children… */}
</ClickableBox>
```

(imports: `ClickableBox` from `../ClickableBox.js`, `theme` from `../theme.js`.)

`App.tsx` palette render: `paletteProps` gains

```ts
    onRowPress: (i: number) => {
      if (i === paletteSel) return void paletteEnter();
      setPaletteSel(i);
    },
```

`AddRepoForm.tsx` — click a field row to focus that field; wrap both field rows:

```tsx
      <ClickableBox gap={1} hoverBg={theme.hoverBg} onPress={() => !busy && setField("nwo")}>
        <Text dimColor>owner/repo:</Text>
        <TextField /* …unchanged… */ />
      </ClickableBox>
      <ClickableBox gap={1} hoverBg={theme.hoverBg} onPress={() => !busy && setField("path")}>
        <Text dimColor>local clone:</Text>
        <TextField /* …unchanged… */ />
      </ClickableBox>
```

(imports: `ClickableBox`, `theme`.)

- [ ] **Step 4: Verify** — `npx vitest run tests/tuiMouseApp.test.tsx tests/tuiPalette.test.tsx tests/tuiModal.test.tsx tests/tuiInteractive.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; then full suite.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A
git commit -m "feat(tui): mouse for palette/add-repo; click-outside closes modal views"
```

---

### Task 8: ConfigView mouse — sections, lever rows, wheel

**Files:**

- Modify: `src/tui/components/ConfigView.tsx`
- Test: `tests/configView.test.tsx` (extend — it already renders ConfigView directly; wrap those renders in `<MouseProvider>` where clicks are asserted)

**Interfaces:**

- Consumes: `ClickableBox`, `MouseProvider` (test-side), `theme.hoverBg`.
- Produces: no new external props — ConfigView owns its interactions.

- [ ] **Step 1: Failing tests** — add to `tests/configView.test.tsx` (reuse its existing tmp-config scaffolding; `press` helper as in tuiClickable tests; find rows by frame line):

```tsx
it("clicking a section in the left pane switches sections", async () => {
  const r = renderConfigViewInProvider(); // helper: <MouseProvider><ConfigView …/></MouseProvider>
  await until(() => (r.lastFrame() ?? "").includes("general"));
  const y = lineOf(r.lastFrame() ?? "", "worker");
  r.stdin.write(press(3, y));
  await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("▌ worker"));
});

it("clicking a lever row focuses it; clicking the focused row activates (boolean toggles)", async () => {
  const r = renderConfigViewInProvider();
  await until(() => (r.lastFrame() ?? "").includes("general"));
  // navigate to a section with a boolean lever via click, then click its row twice
  const y = lineOf(r.lastFrame() ?? "", "sandbox");
  r.stdin.write(press(3, y));
  await until(() => (r.lastFrame() ?? "").includes("▌ sandbox"));
  const rowY = lineOf(r.lastFrame() ?? "", "enabled");
  r.stdin.write(press(30, rowY)); // focus
  await until(() => (r.lastFrame() ?? "").split("\n")[rowY].includes("▌"));
  r.stdin.write(press(30, rowY)); // activate = toggle
  await until(() => (r.lastFrame() ?? "").includes("Saved"));
});

it("wheel over the lever pane moves the field cursor", async () => {
  const r = renderConfigViewInProvider();
  await until(() => (r.lastFrame() ?? "").includes("general"));
  r.stdin.write("[<65;30;5M"); // wheelDown in the right pane
  await until(() => !(r.lastFrame() ?? "").split("\n")[firstRowY].includes("▌"));
});
```

Where the wheel spec's setup replaces the bare write above with a row-anchored one:

```tsx
// The first lever row carries ▌ initially; after one wheelDown it must not.
const firstRowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
expect((r.lastFrame() ?? "").split("\n")[firstRowY]).toContain("▌");
r.stdin.write(wheelDown(30, firstRowY)); // helper from tuiClickable.test.tsx
```

(Exact lever names: use `junco` levers visible in the frame — the `general` section lists `vaultRoot`; the `sandbox` section has boolean `enabled`; verify against `src/configLevers.ts` before hardcoding. `renderConfigViewInProvider` is a local helper: write a minimal valid config to a tmp file exactly like the file's existing tests do, then `render(<MouseProvider><ConfigView configPath={p} onExit={onExit} visibleRows={8}/></MouseProvider>)`. Define `press`/`move`/`wheelDown`/`lineOf` locally as in `tests/tuiClickable.test.tsx` and `tests/tuiMouseApp.test.tsx`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in `ConfigView.tsx`. Extract the arrow-key movement into helpers (used by keys AND wheel):

```ts
const moveField = (d: 1 | -1): void => {
  setFieldIdx((i) => {
    const next = Math.max(0, Math.min(fields.length - 1, i + d));
    setScrollOffset((o) => clampScrollOffset(o, next, visibleCount, fields.length));
    return next;
  });
};
const moveSection = (d: 1 | -1): void => {
  setSectionIdx((i) => Math.max(0, Math.min(SECTIONS.length - 1, i + d)));
  setFieldIdx(0);
  setScrollOffset(0);
};
```

(Rewrite the existing up/down/left/right key branches to call these.)

Left pane: section row `<Text key={s.key} …>` becomes

```tsx
<ClickableBox
  key={s.key}
  hoverBg={sel ? theme.selectionBg : theme.hoverBg}
  onPress={() => {
    if (editing !== null) setEditing(null);
    setSectionIdx(i);
    setFieldIdx(0);
    setScrollOffset(0);
  }}
>
  <Text color={sel ? theme.accent : undefined} bold={sel} wrap="truncate-end">
    {sel ? "▌ " : "  "}
    {s.key}
  </Text>
</ClickableBox>
```

and the left-pane column Box gains `onWheel={(d) => moveSection(d)}` (→ ClickableBox).

Right pane: the pane's column Box → ClickableBox with `onWheel={(d) => { if (editing === null) moveField(d); }}`; the lever row Box (`key={l.path}`) becomes:

```tsx
<ClickableBox
  key={l.path}
  width="100%"
  backgroundColor={sel ? theme.selectionBg : undefined}
  hoverBg={sel ? theme.selectionBg : theme.hoverBg}
  gap={1}
  onPress={() => {
    if (editing !== null) {
      setEditing(null); // click during edit cancels FIRST (spec §3)
      return;
    }
    if (i === fieldIdxSafe) {
      startEdit();
      return;
    }
    setFieldIdx(i);
    setScrollOffset((o) => clampScrollOffset(o, i, visibleCount, fields.length));
  }}
>
  {/* …unchanged row children… */}
</ClickableBox>
```

(imports: `ClickableBox` from `../ClickableBox.js`.)

- [ ] **Step 4: Verify** — `npx vitest run tests/configView.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; full suite.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/ConfigView.tsx tests/configView.test.tsx
git add -A
git commit -m "feat(tui): mouse control in the config editor"
```

---

### Task 9: ReviewView + LOCAL dashboard mouse

**Files:**

- Modify: `src/tui/components/ReviewView.tsx`, `src/tui/components/LocalDashboard.tsx`, `src/tui/components/QueueView.tsx`, `src/tui/App.tsx`
- Test: `tests/tuiLocalApp.test.tsx` (extend), `tests/tuiMouseApp.test.tsx` (review specs)

**Interfaces:**

- Consumes: `ClickableBox`, `theme.hoverBg`.
- Produces (exact new optional props):
  - `ReviewView`: `onRowPress?: (index: number) => void; onFindingPress?: (index: number) => void; onDraftWheel?: (dir: 1 | -1) => void`
  - `QueueView`: `onRowPress?: (row: number) => void` (actionable-row index: waiting `i`, recent `waiting.length + j`; only wired when `selectable`)
  - `SectionRail`: `onSectionPress?: (s: LocalSection) => void`
  - `OutboxSection` / `ReposSection` / `WorktreesSection`: `onRowPress?: (index: number) => void`
  - `DaemonSection`: `onWheel?: (dir: 1 | -1) => void`
  - `LocalDashboard` (default export): `onSectionPress?: (s: LocalSection) => void; onRowPress?: (index: number) => void; onDaemonWheel?: (dir: 1 | -1) => void` — threaded to the pieces above.

- [ ] **Step 1: Failing tests.**

`tests/tuiLocalApp.test.tsx` (this REPLACES the retired "body click is a no-op" contract):

```tsx
it("clicking a section in the LOCAL rail selects it; clicking again enters the body", async () => {
  const r = renderApp({ initialUiMode: "local" });
  await until(() => (r.lastFrame() ?? "").includes("sections"));
  const y = lineOf(r.lastFrame() ?? "", "repos");
  r.stdin.write(press(3, y));
  await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("▌"));
  r.stdin.write(press(3, y));
  await until(() =>
    /* repos body focused: its border shows accent — assert on the section body header */ (
      r.lastFrame() ?? ""
    ).includes("repos"),
  );
});

it("clicking a LOCAL body row moves the cursor and focuses the body", async () => {
  const r = renderApp({ initialUiMode: "local" }); // fixture must seed ≥2 outbox ops
  await until(() => (r.lastFrame() ?? "").includes("sections"));
  const sectionY = lineOf(r.lastFrame() ?? "", "outbox");
  r.stdin.write(press(3, sectionY)); // select the outbox section
  await until(() => (r.lastFrame() ?? "").split("\n")[sectionY].includes("▌"));
  // Rows render as "<age> <op.kind> <issueKey>" — locate the second op by its
  // issueKey from the fixture data (extend tests/helpers/localFixtures.ts if
  // its outbox snapshot has fewer than two ops).
  const rowY = lineOf(r.lastFrame() ?? "", "acme/api#2");
  r.stdin.write(press(30, rowY));
  await until(() => (r.lastFrame() ?? "").split("\n")[rowY].includes("▌"));
});
```

`tests/tuiMouseApp.test.tsx` — review specs (fixture: seed `client.listReview`/`listCommentDrafts` fakes the way the existing review tests in `tuiApp.test.tsx` do — reuse their fake-client pattern):

```tsx
it("review: click a batch row twice to open it; click a finding to toggle its checkbox", async () => {
  /* open review with v; click batch row (cursor moves), click again (checklist opens),
     click a finding row → its [x] flips; assert via frame text */
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement components.**

`ReviewView.tsx`: add the three props. In combined-list mode, both row Boxes (`key={b.id}` and `key={d.id}`) → ClickableBox with `hoverBg={sel ? theme.selectionBg : theme.hoverBg}` and `onPress={onRowPress ? () => onRowPress(idx) : undefined}`. In checklist mode, the finding row Box (`key={f.fingerprint}`) → ClickableBox with `onPress={onFindingPress ? () => onFindingPress(idx) : undefined}` (same hoverBg rule). In draft-preview mode, the root column Box → ClickableBox with `onWheel={onDraftWheel}`.

`QueueView.tsx`: add `onRowPress`. Where waiting rows push (`key={`w-${w.id}`}`) and recent rows push (`key={`f-…`}`), wrap the pushed `<Text>` in a ClickableBox when `selectable === true`:

```tsx
const pressable = (row: number, child: React.JSX.Element, key: string): React.JSX.Element =>
  selectable === true && onRowPress ? (
    <ClickableBox key={key} hoverBg={theme.hoverBg} onPress={() => onRowPress(row)}>
      {child}
    </ClickableBox>
  ) : (
    child
  );
```

Push `pressable(i, <Text key={…}>…</Text>, `w-${w.id}`)` for waiting and `pressable(snap.waiting.length + j, …, `f-${r.id}-${r.finishedAt}`)` for recent (move the `key` onto the wrapper when wrapped). The non-selectable GitHub `t` view renders byte-identically (guard keeps rows bare).

`LocalDashboard.tsx`: add the three props to the default export; `SectionRail` gains `onSectionPress` and its section row Box (`key={s}`) → ClickableBox with `onPress={onSectionPress ? () => onSectionPress(s) : undefined}` + hoverBg rule; `OutboxSection`/`ReposSection`/`WorktreesSection` row Boxes (`key={s.id}` / `key={r.path}` / `key={w.path}`) → ClickableBox with `onPress={onRowPress ? () => onRowPress(idx) : undefined}` + hoverBg rule; `DaemonSection`'s border Box → ClickableBox with `onWheel`; `LocalDashboard` threads: `onSectionPress` → SectionRail, `onRowPress` → the three list sections and `QueueView` (queue section), `onDaemonWheel` → DaemonSection.

- [ ] **Step 4: App wiring** (`App.tsx`).

Review handlers (place near the other client handlers; these duplicate the key recipes EXACTLY — same setReviewState transitions as `key.return`, space, and j/k):

```tsx
const reviewRowPress = (idx: number): void => {
  if (confirm !== null) return;
  setReviewState((s) => {
    if (s.open) return s;
    if (idx !== s.cursor) return { ...s, cursor: idx };
    if (idx < s.batches.length) {
      const batch = s.batches[idx];
      if (!batch) return s;
      return {
        ...s,
        open: {
          kind: "batch",
          batchIdx: idx,
          findingCursor: 0,
          checked: new Set(batch.findings.map((f) => f.fingerprint)),
        },
      };
    }
    const draftIdx = idx - s.batches.length;
    if (!s.drafts[draftIdx]) return s;
    return { ...s, open: { kind: "draft", draftIdx, scroll: 0 } };
  });
};
const reviewFindingPress = (idx: number): void => {
  if (confirm !== null) return;
  setReviewState((s) => {
    if (!s.open || s.open.kind !== "batch") return s;
    const batch = s.batches[s.open.batchIdx];
    if (!batch) return s;
    const checked = new Set(s.open.checked);
    const fp = batch.findings[idx]?.fingerprint;
    if (fp) {
      if (checked.has(fp)) checked.delete(fp);
      else checked.add(fp);
    }
    return { ...s, open: { ...s.open, findingCursor: idx, checked } };
  });
};
const reviewDraftWheel = (d: 1 | -1): void => {
  setReviewState((s) => {
    if (!s.open || s.open.kind !== "draft") return s;
    const dft = s.drafts[s.open.draftIdx];
    const max = dft ? Math.max(0, dft.draft.split("\n").length - 1) : 0;
    return { ...s, open: { ...s.open, scroll: Math.max(0, Math.min(max, s.open.scroll + d)) } };
  });
};
```

Render site: `<ReviewView state={reviewState} height={listHeight} focused onRowPress={reviewRowPress} onFindingPress={reviewFindingPress} onDraftWheel={reviewDraftWheel} />`.

LOCAL handlers:

```tsx
const localSectionPress = (s: LocalSection): void => {
  if (confirm !== null) return;
  if (localSection === s) {
    setLocalFocus("body"); // click-again = enter (the l/→/enter key)
    return;
  }
  setLocalSection(s);
  setLocalScroll(0);
  setLocalFocus("rail");
};
const localRowPress = (idx: number): void => {
  if (confirm !== null) return;
  setLocalFocus("body");
  if (idx === localCursorSafe && localSection === "repos") {
    const t = localTarget;
    if (t?.kind === "repo") openRepoBrowser(t.repo.nwo ?? "");
    return; // click-again on a repo row = the nondestructive `o` action
  }
  setLocalCursor((m) => ({ ...m, [localSection]: idx }));
};
```

Render site: `<LocalDashboard … onSectionPress={localSectionPress} onRowPress={localRowPress} onDaemonWheel={(d) => setLocalScroll((s) => Math.max(0, s + d))} />`. (`LocalSection` type is already imported in App via the localSnapshot imports; if not, `import type { LocalSection } from "./localSnapshot.js";`.)

- [ ] **Step 5: Verify** — `npx vitest run tests/tuiLocalApp.test.tsx tests/tuiLocal.test.tsx tests/tuiLocalActions.test.tsx tests/tuiQueue.test.tsx tests/tuiMouseApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; full suite.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tui tests
git add -A
git commit -m "feat(tui): mouse for review queue and LOCAL dashboard"
```

---

### Task 10: Clickable footer hint chips

**Files:**

- Modify: `src/tui/components/Chrome.tsx` (Footer), `src/tui/App.tsx` (per-view actions map)
- Test: `tests/tuiChrome.test.tsx` (Footer renders identically without actions), `tests/tuiMouseApp.test.tsx` (chip click spec)

**Interfaces:**

- Consumes: `ClickableBox`, `theme.hoverBg`.
- Produces: `Footer` prop `actions?: Record<string, () => void>` — a chip whose hint KEY has an entry is clickable; others render inert. Hint tuples themselves are unchanged (`hintsFor`/`localHintsFor` untouched).

- [ ] **Step 1: Failing test** — `tests/tuiMouseApp.test.tsx`:

```tsx
it("footer chip: clicking 't queue' opens the queue view; 'esc/t' closes it", async () => {
  const r = renderApp({ initialUiMode: "github" });
  await until(() => (r.lastFrame() ?? "").includes("1 repos"));
  const f = r.lastFrame() ?? "";
  const footerY = f.split("\n").length - 1;
  const x = f.split("\n")[footerY].indexOf("t queue");
  r.stdin.write(press(x, footerY));
  await until(() => (r.lastFrame() ?? "").includes("RUNNING"));
  const f2 = r.lastFrame() ?? "";
  const x2 = f2.split("\n")[footerY].indexOf("esc/t");
  r.stdin.write(press(x2, footerY));
  await until(() => (r.lastFrame() ?? "").includes("1 repos"));
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`Chrome.tsx` Footer — chips become flexShrink-0 boxes; clickable when an action exists (visual layout: same key+label text, separators preserved; overflow now clips instead of ellipsizing — acceptable, the hint row is informational):

```tsx
export function Footer({
  hints,
  actions,
}: {
  hints: [string, string][];
  actions?: Record<string, () => void>;
}): React.JSX.Element {
  return (
    <Box paddingX={1} height={1} overflow="hidden">
      {hints.map(([k, label], i) => {
        const run = actions?.[k];
        const chip = (
          <Text>
            <Text color={theme.accent}>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        );
        return (
          <Box key={k} flexShrink={0}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            {run ? (
              <ClickableBox onPress={run} hoverBg={theme.hoverBg}>
                {chip}
              </ClickableBox>
            ) : (
              chip
            )}
          </Box>
        );
      })}
    </Box>
  );
}
```

`Workspace.tsx` — thread `footerActions` through: add prop `footerActions?: Record<string, () => void>` and pass to `<Footer hints={hints} actions={footerActions} />`.

`App.tsx` — build the map (movement hints — `↑/↓`, `←/→`, `type`, `space`, `a/n`, `[/]`, `any key` — stay inert by simply not having entries; every entry duplicates an existing key recipe verbatim):

```tsx
const footerActions: Record<string, () => void> = useMemo(() => {
  if (confirm !== null) return {};
  if (uiMode === "local" && view !== "config") {
    return {
      q: () => {
        exit();
        onExit();
      },
      "?": () => setView("help"),
      r: () => void forceLocalRefresh(),
      m: () => handleModeTab("github"),
      "←": () => setLocalFocus("rail"),
    };
  }
  switch (view) {
    case "detail":
      return {
        o: openDetailIssueInBrowser,
        esc: () => {
          setScroll(0);
          setView("main");
        },
      };
    case "prDetail":
      return { esc: () => setView(prDetail?.from ?? "main"), o: openPrDetailInBrowser };
    case "queue":
      return {
        "esc/t": () => {
          setScroll(0);
          setView("main");
        },
      };
    case "prs":
      return {
        enter: () => openPrDetail(selectedPr, "prs"),
        o: openSelectedPr,
        "esc/p": () => {
          setScroll(0);
          setView("main");
        },
      };
    case "cmdOutput":
      return {
        esc: () => {
          setScroll(0);
          setView("palette");
        },
        ...(cmd && !cmd.running ? { r: () => runPaletteCommand(cmd.name, cmd.extraArgs) } : {}),
      };
    case "palette":
      return { esc: () => setView("main"), enter: () => paletteEnter() };
    case "addRepo":
      return { esc: () => setView("main") };
    case "config":
      return { esc: () => setView("main") };
    case "review":
      return { esc: () => setView("main") };
    case "help":
      return {};
    case "main":
      return {
        q: () => {
          exit();
          onExit();
        },
        "?": () => setView("help"),
        t: () => {
          setScroll(0);
          setView("queue");
        },
        p: () => {
          setScroll(0);
          setView("prs");
          void refreshAll({ scope: "monitor" });
        },
        ":": () => {
          setPaletteFilter("");
          setPaletteSel(0);
          setPaletteArgsMode(false);
          setPaletteArgs("");
          setView("palette");
        },
        ",": () => setView("config"),
        m: () => handleModeTab("local"),
        w: () => {
          if (watchlistError)
            return void showToast("error", "watchlist unreadable — fix it before adding");
          setAddRepoError(null);
          setView("addRepo");
        },
        r: () => {
          setRefreshing(true);
          void refreshAll().finally(() => setRefreshing(false));
        },
        enter: () => void openDetail(),
        d: () => void runAction("dispatch"),
        a: () => void runAction("approve"),
        o: () => void openBrowser(),
        "/": () => {
          setFiltering(true);
          setPane(2);
        },
      };
  }
}, [confirm, uiMode, view, cmd, prDetail, selectedPr, watchlistError /* + the stable callbacks */]);
```

Pass `footerActions={footerActions}` on the `<Workspace …>` element. NOTE: keys must match `hintsFor`'s literal hint keys exactly (e.g. `"esc/t"`, `"esc/p"`) — a mismatch renders an inert chip, not a crash.

- [ ] **Step 4: Verify** — `npx vitest run tests/tuiChrome.test.tsx tests/tuiWorkspace.test.tsx tests/tuiMouseApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; full suite (Footer signature change may touch snapshot-ish frame tests — hint text is unchanged, so failures indicate a real layout regression: investigate, don't blindly update).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui tests
git add -A
git commit -m "feat(tui): clickable footer hint chips across all views"
```

---

### Task 11: Docs + full gate

**Files:**

- Modify: `ARCHITECTURE.md` (TUI module map: mouseRegions/MouseProvider/ClickableBox replace hitTest/useMouse), `CHANGELOG.md` (Unreleased → Added: full-TUI mouse control with hover; Changed: mouse protocol now any-motion)

**Steps:**

- [ ] **Step 1:** Update `ARCHITECTURE.md`'s TUI section: remove `hitTest.ts`/`useMouse.ts` mentions, add one line each for `mouseRegions.ts` (yoga-walking region store — the only yogaNode consumer), `MouseProvider.tsx` (stdin pipeline + hover store), `ClickableBox.tsx` (drop-in Box mouse target), `useGuardedInput.ts` (CSI leak guard).
- [ ] **Step 2:** CHANGELOG under `[Unreleased]`:

```markdown
### Added

- Full-TUI mouse control with hover feedback: config editor, command palette, queue, review, help, add-repo, LOCAL dashboard, plus clickable footer hint chips in every view.

### Changed

- Dashboard mouse protocol upgraded to SGR any-motion tracking (hover); click targets now resolve via a render-time hit-region registry.
```

- [ ] **Step 3: Full gate** — `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` (capture vitest exit code explicitly). Expected: all green.
- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: architecture + changelog for TUI mouse registry"
```

- [ ] **Step 5:** Manual smoke (optional but recommended): `npm run build && node dist/cli.js dashboard` from a THROWAWAY sandboxed HOME (never the repo root — live config!) per CLAUDE.md's sandbox recipe; verify hover highlights, row clicks, wheel, config editor clicks, footer chips.

---

## Plan self-review notes

- Spec §1 (protocol/move/coalescing/hover store) → Tasks 1–3. §2 (registry/ClickableBox/lazy rects/miss/no-layering) → Tasks 2–3, 5–7. §3 semantics: migrated surfaces (Task 6), config (Task 8), palette/help/addRepo (Task 7), queue GH wheel (Task 6), review + LOCAL (Task 9), footer chips (Task 10), confirm-modal keyboard gate (guards in every handler + miss handler returning null under `confirm`). §5 testing → per-task tests. Wizard/legend chips and `Select`/`MultiSelect` are **Plan B** (spec notes wizard scope ships with the FTUE branch).
- Known drift risks called out in-task: fixture row coordinates (locate by frame text, never hardcode y), Footer overflow behavior change, LOCAL toast-dismiss-on-click parity change.
