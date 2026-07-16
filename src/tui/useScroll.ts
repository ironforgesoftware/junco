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
