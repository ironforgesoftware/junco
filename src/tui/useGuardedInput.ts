/**
 * useInput minus leaked mouse CSI: with reporting enabled, ink parses each
 * SGR sequence as one keypress and hands "[<b;x;yM" to every handler. This
 * wrapper is the ONE place that drops them — every TUI input handler goes
 * through it (convention; MouseProvider owns the real events via stdin).
 */
import { useInput, type Key } from "ink";
import { isMouseInput } from "./mouse.js";

export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options?: { isActive?: boolean },
): void {
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    handler(input, key);
  }, options);
}
