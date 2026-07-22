import { useState, useRef, useCallback, useEffect } from "react";
import type { ToastKind } from "../theme.js";

export interface Toast {
  kind: ToastKind;
  text: string;
}

export function useToast(): {
  toast: Toast | null;
  showToast: (kind: ToastKind, text: string) => void;
  dismissToast: () => void;
} {
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: ToastKind, text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  return { toast, showToast, dismissToast };
}
