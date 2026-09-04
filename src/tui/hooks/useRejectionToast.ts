import { useEffect } from "react";
import type { ToastKind } from "../theme.js";

/**
 * The dashboard's process-level safety net for unhandled promise rejections
 * (#455).
 *
 * The dashboard fires several verbs as `void asyncVerb()`. Ruling R34 (the
 * #445 review) made every one of them catch-and-toast, so none can reject —
 * but a new call site that forgets is a Node 22 process EXIT, which for a
 * full-screen Ink app is a hard quit with no message and a terminal left in
 * the alternate buffer. Registering ANY `unhandledRejection` listener
 * suppresses that exit, so this hook's whole job is to leave the operator a
 * trace and get out of the way. It never exits and never rethrows.
 *
 * Scoped to the mount rather than the process: the suite renders many Apps in
 * one process, and a listener outliving its App would toast into a surface
 * that is no longer there. The durable, whole-process half of the net (and the
 * worker-log line) lives in the dashboard entry, src/dashboardCmd.ts.
 *
 * `showToast` (useToast) is stable, so the effect registers once per mount.
 */
export function useRejectionToast(showToast: (kind: ToastKind, text: string) => void): void {
  useEffect(() => {
    const onRejection = (reason: unknown): void => {
      showToast(
        "error",
        `internal error: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    };
    process.on("unhandledRejection", onRejection);
    return () => {
      process.off("unhandledRejection", onRejection);
    };
  }, [showToast]);
}
