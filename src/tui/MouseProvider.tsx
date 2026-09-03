/**
 * App-root mouse pipeline: enables SGR any-motion reporting for the app's
 * lifetime (restored on unmount AND process exit), parses stdin chunks, and
 * dispatches against the hit-region store. Motion is coalesced per chunk
 * (last position wins) and hover updates notify only the affected regions —
 * pointer motion that changes nothing re-renders nothing. Held-button motion
 * is a DRAG, routed to the region the press landed on (the capture) until the
 * button comes up, so a scrollbar keeps scrolling once the pointer slides off
 * its one-column track.
 */
import React, { createContext, useContext, useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE, parseMouse, type MouseEvent } from "./mouse.js";
import { createMouseStore, type MouseStore, type Rect } from "./mouseRegions.js";

/** A terminal cell in a region's own coordinates, clamped to its bounds — a
 * drag that has wandered past the end of a scrollbar still means "its last
 * row", never a negative offset or one off the end. */
function localPoint(rect: Rect, x: number, y: number): [number, number] {
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(v, Math.max(0, hi - 1)));
  return [clamp(x - rect.x, rect.width), clamp(y - rect.y, rect.height)];
}

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
  // The drag capture: the region an `onPressAt` press landed on owns every
  // drag until the button comes up, wherever the pointer goes (a scrollbar
  // must keep scrolling once the pointer slides off its one-column track).
  const dragCaptureRef = useRef<number | null>(null);

  useEffect(() => {
    // TTY-gated: `junco dashboard` already refuses to mount without a real
    // terminal (dashboardCmd.ts), so this is a no-op guard in production.
    // It matters for tests: ink-testing-library's fake stdout has no isTTY,
    // and a raw write() there is indistinguishable from a real frame —
    // writing the enable sequence would permanently clobber `lastFrame()`.
    const isTTY = Boolean(stdout.isTTY);
    if (isTTY) stdout.write(MOUSE_ENABLE);
    const onData = (data: unknown): void => {
      let lastMove: MouseEvent | null = null;
      // Coalesced like moves, but paired with the region captured AT THE TIME:
      // a release later in the same chunk must not steal the drag's target.
      let lastDrag: { ev: MouseEvent; id: number } | null = null;
      for (const ev of parseMouse(String(data))) {
        if (ev.kind === "move") {
          lastMove = ev; // coalesce: only the final position this chunk matters
        } else if (ev.kind === "press") {
          pressObserverRef.current?.();
          const hit = store.resolve(ev.x, ev.y);
          const h = hit?.handlers;
          h?.onPress?.();
          // EVERY press rewrites the capture, arming or clearing it: a release
          // is not guaranteed to arrive (button up outside the window, focus
          // lost mid-drag, a dropped chunk), and a capture that outlived its
          // gesture would hand the next held-button motion anywhere on screen
          // to a scrollbar the operator had already let go of.
          dragCaptureRef.current = hit && h?.onPressAt ? hit.id : null;
          if (hit && h?.onPressAt) h.onPressAt(...localPoint(hit.rect, ev.x, ev.y));
          // A region answering EITHER press form is a hit; only a press that
          // reached nothing at all is a miss.
          if (!h?.onPress && !h?.onPressAt) missRef.current?.();
        } else if (ev.kind === "drag") {
          if (dragCaptureRef.current !== null) lastDrag = { ev, id: dragCaptureRef.current };
        } else if (ev.kind === "release") {
          dragCaptureRef.current = null;
        } else {
          const hit = store.resolve(ev.x, ev.y, { needsWheel: true });
          hit?.handlers.onWheel?.(ev.kind === "wheelDown" ? 1 : -1);
        }
      }
      if (lastDrag) {
        // Re-resolved rather than remembered: a region that unmounted mid-drag
        // (or scrolled out of the tree) simply has nothing to hand the drag to.
        const held = store.byId(lastDrag.id);
        held?.handlers.onDrag?.(...localPoint(held.rect, lastDrag.ev.x, lastDrag.ev.y));
      }
      if (lastMove) store.setHoveredFromPoint(lastMove.x, lastMove.y);
    };
    stdin.on("data", onData);
    const restore = (): void => {
      if (isTTY) stdout.write(MOUSE_DISABLE);
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
