import { useState, useCallback } from "react";

/** LOCAL destructive-action gate: a `y/n` modal that owns input while open.
 * `onConfirm` fires the (already-composed) spawn on `y`/enter; `n`/esc drops it. */
export interface ConfirmState {
  title: string;
  body: string;
  danger: boolean;
  onConfirm: () => void;
}

export function useConfirm(): {
  confirm: ConfirmState | null;
  askConfirm: (state: ConfirmState) => void;
  clearConfirm: () => void;
} {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const askConfirm = useCallback((state: ConfirmState) => setConfirm(state), []);
  const clearConfirm = useCallback(() => setConfirm(null), []);

  return { confirm, askConfirm, clearConfirm };
}
