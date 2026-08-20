import { useState, useCallback } from "react";

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
} {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const askConfirm = useCallback((state: ConfirmState) => setConfirm(state), []);
  const clearConfirm = useCallback(() => setConfirm(null), []);

  return { confirm, askConfirm, clearConfirm };
}
