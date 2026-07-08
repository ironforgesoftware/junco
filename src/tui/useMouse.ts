// src/tui/useMouse.ts
import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE, parseMouse, type MouseEvent } from "./mouse.js";

/**
 * Terminal mouse reporting for the dashboard's lifetime: SGR click+wheel on
 * mount, parsed events to `onEvent` (held in a ref — never a stale closure),
 * restore on unmount AND process exit — a crash must never leave the
 * operator's terminal swallowing clicks. Ink restores the alt screen; this is
 * the mouse-mode analogue.
 */
export function useMouse(onEvent: (ev: MouseEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write(MOUSE_ENABLE);
    const onData = (data: unknown): void => {
      for (const ev of parseMouse(String(data))) handler.current(ev);
    };
    stdin.on("data", onData);
    const restore = (): void => {
      stdout.write(MOUSE_DISABLE);
    };
    process.on("exit", restore);
    return () => {
      stdin.off("data", onData);
      process.off("exit", restore);
      restore();
    };
  }, [stdin, stdout]);
}
