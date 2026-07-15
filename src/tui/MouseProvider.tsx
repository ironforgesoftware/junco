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
    // TTY-gated: `junco dashboard` already refuses to mount without a real
    // terminal (dashboardCmd.ts), so this is a no-op guard in production.
    // It matters for tests: ink-testing-library's fake stdout has no isTTY,
    // and a raw write() there is indistinguishable from a real frame —
    // writing the enable sequence would permanently clobber `lastFrame()`.
    const isTTY = Boolean(stdout.isTTY);
    if (isTTY) stdout.write(MOUSE_ENABLE);
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
