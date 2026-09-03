/**
 * The "pause follow" step every tail-following surface shares (chat, ticket
 * transcript, log overlay — key and wheel alike), made safe against a run of
 * presses replayed inside ONE render closure.
 *
 * The recipe is "if following: land at the tail, then stop following, then
 * scroll" — the landing keeps the step relative to the bottom instead of a
 * stale offset. Its guard used to be the render's `follow` value, which is
 * the same for every replay of a held key (useGuardedInput hands "kkk" to the
 * handler three times without a render in between) and for every notch of a
 * wheel burst (MouseProvider dispatches a chunk's events synchronously). The
 * scroll itself composes — `scrollBy` is a functional update — but `toEnd`
 * sets an absolute offset, so three "pause, step" pairs landed at the tail
 * three times and netted one row. This latch is the guard instead: `follow`
 * as of the last render, cleared by the first pause taken in a closure and
 * re-armed by a resume, so the second and third replays just step.
 *
 * Why a render-synced ref is enough: the ref is never staler than the value
 * it replaces (re-assigned every render), and the only writers that bypass
 * it — cursor moves, the scrollbar's jump, `g`/`G` — either cannot share a
 * closure with a pause (a replayed run is one repeated printable key,
 * `isHeldKeyRun`) or compose on their own through functional state.
 */
import { useCallback, useMemo, useRef } from "react";

export interface FollowLatch {
  /** Pause if following — the surface's own pause recipe runs once. Returns
   * whether it did, so a toggle can branch on it. */
  pause: () => boolean;
  /** Resume following: the surface's resume recipe, and the latch re-arms. */
  resume: () => void;
}

export function useFollowLatch(
  follow: boolean,
  actions: { pause: () => void; resume: () => void },
): FollowLatch {
  const followRef = useRef(follow);
  followRef.current = follow;
  // The recipes are usually inline arrows (they close over the surface's own
  // setters), so they live in a ref too: the returned functions stay stable
  // for the memoized handler tables that hold them.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const pause = useCallback((): boolean => {
    if (!followRef.current) return false;
    followRef.current = false;
    actionsRef.current.pause();
    return true;
  }, []);
  const resume = useCallback((): void => {
    followRef.current = true;
    actionsRef.current.resume();
  }, []);
  // One identity for the pair, so a handler table can list the latch itself.
  return useMemo(() => ({ pause, resume }), [pause, resume]);
}
