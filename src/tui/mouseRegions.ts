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

interface RegionHandlers {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
  /** A press, with the cell's position INSIDE the region (clamped to it) —
   * the scrollbar's "jump to this row". Runs alongside `onPress`, and arms the
   * drag capture: every drag until the button comes up is this region's. */
  onPressAt?: (localX: number, localY: number) => void;
  /** A held-button move, in the captured region's own coordinates (clamped),
   * even when the pointer has wandered off it. */
  onDrag?: (localX: number, localY: number) => void;
}

interface ResolvedRegion {
  id: number;
  handlers: RegionHandlers;
  /** Absolute rect at resolve time — the frame of reference for the local
   * coordinates `onPressAt`/`onDrag` receive. */
  rect: Rect;
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
  /** The region with this id, if it is still registered AND still in the tree
   * — how a captured drag finds its target after the pointer has left it. */
  byId(id: number): ResolvedRegion | null;
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
    let bestRect: Rect | null = null;
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
        bestRect = rect;
        bestDepth = depth;
      }
    }
    return best && bestRect ? { id: best.id, handlers: best.handlers, rect: bestRect } : null;
  };

  const byId = (id: number): ResolvedRegion | null => {
    const r = regions.get(id);
    const node = r?.getNode();
    const rect = node ? absoluteRect(node) : null;
    return r && rect ? { id, handlers: r.handlers, rect } : null;
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
    byId,
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
        // Prune the now-empty Set so the map doesn't retain a per-id entry for
        // a region whose subscribers have all unmounted.
        if (set.size === 0) subscribers.delete(id);
      };
    },
  };
}
