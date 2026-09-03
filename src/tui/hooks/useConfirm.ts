import { useState, useCallback, useRef } from "react";

/** LOCAL destructive-action gate: a `y/n` modal that owns input while open.
 * `onConfirm` fires the (already-composed) spawn on `y`/enter; `n`/esc drops it.
 * `onCancel` (optional) fires on that drop — for gates whose decline is itself
 * an outcome worth surfacing (e.g. the add-repo bot-grant skip toast). */
export interface ConfirmState {
  title: string;
  body: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function useConfirm(): {
  confirm: ConfirmState | null;
  askConfirm: (state: ConfirmState) => void;
  clearConfirm: () => void;
  /** Answer the open confirm — ONCE per opening. A held `y` reaches App's
   * cascade as a run replayed inside a single render closure (useGuardedInput),
   * where `confirm` is still the open modal for every replay; the answer has
   * to latch here, not in the closure, or a destructive action would fire
   * twice. Clears the modal BEFORE firing the callback, so a callback that
   * opens the next confirm (the unwatch `--plan` continuation) composes. */
  settle: (outcome: "confirm" | "cancel") => void;
} {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // The claimable copy of `confirm`: set with it, nulled the moment it is
  // answered, so a second answer in the same closure finds nothing to fire.
  const openRef = useRef<ConfirmState | null>(null);

  const askConfirm = useCallback((state: ConfirmState) => {
    openRef.current = state;
    setConfirm(state);
  }, []);
  const clearConfirm = useCallback(() => {
    openRef.current = null;
    setConfirm(null);
  }, []);
  const settle = useCallback((outcome: "confirm" | "cancel") => {
    const open = openRef.current;
    if (open === null) return;
    openRef.current = null;
    setConfirm(null);
    if (outcome === "confirm") open.onConfirm();
    else open.onCancel?.();
  }, []);

  return { confirm, askConfirm, clearConfirm, settle };
}
