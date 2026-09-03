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

  it("resolve tie-break: same depth, overlapping rects — later registration wins", () => {
    // Two siblings of pane (both depth 2) whose rects overlap at (10, 2).
    const wideA = el(yoga(0, 1, 80, 2), pane); // absolute y=2..3
    const rowOverlap = el(yoga(0, 1, 80, 1), pane); // absolute y=2
    const store = createMouseStore();
    store.register(1, () => wideA, { onPress: () => {} });
    store.register(2, () => rowOverlap, { onPress: () => {} });
    expect(store.resolve(10, 2)?.id).toBe(2); // later registration wins the tie
    // Reversed registration order: the rule is registration order, not id.
    const store2 = createMouseStore();
    store2.register(2, () => rowOverlap, { onPress: () => {} });
    store2.register(1, () => wideA, { onPress: () => {} });
    expect(store2.resolve(10, 2)?.id).toBe(1);
  });

  // The drag capture (the scrollbar's press-and-hold) needs two things the
  // press path alone never asked for: the region's RECT, so the provider can
  // turn a terminal cell into a row inside the bar, and a way back to a region
  // by id while the pointer wanders outside it.
  it("resolve carries the hit region's absolute rect", () => {
    const store = createMouseStore();
    store.register(1, () => rowA, { onPressAt: () => {} });
    expect(store.resolve(10, 2)).toEqual({
      id: 1,
      handlers: expect.anything(),
      rect: { x: 0, y: 2, width: 80, height: 1 },
    });
  });

  it("byId returns a live region's handlers + rect, and null once it is gone", () => {
    const store = createMouseStore();
    const onDrag = vi.fn();
    const off = store.register(7, () => rowB, { onDrag });
    const hit = store.byId(7);
    expect(hit?.rect).toEqual({ x: 0, y: 3, width: 80, height: 1 });
    hit?.handlers.onDrag?.(0, 0);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(store.byId(999)).toBeNull();
    off();
    expect(store.byId(7)).toBeNull();
    // A region still registered but detached from the tree has no rect either.
    store.register(8, () => undefined, { onDrag });
    expect(store.byId(8)).toBeNull();
  });

  it("unregistering the hovered region clears hover and notifies its subscribers", () => {
    const store = createMouseStore();
    const off = store.register(1, () => rowA, { onPress: () => {} });
    const sub = vi.fn();
    store.subscribe(1, sub);
    store.setHoveredFromPoint(10, 2); // over rowA
    expect(store.isHovered(1)).toBe(true);
    expect(sub).toHaveBeenCalledTimes(1);
    off();
    expect(store.hoveredId()).toBeNull();
    expect(sub).toHaveBeenCalledTimes(2);
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
