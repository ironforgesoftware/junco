/** Suspend the Ink session around an interactive child process (gh's
 * device-flow login): drop raw mode, pause stdin, disable mouse reporting,
 * and leave the alt screen so the child owns the real terminal; restore
 * everything afterwards. TTY-gated like MouseProvider — under
 * ink-testing-library's fake streams this only toggles raw mode. */
import { useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE } from "./mouse.js";

const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";

export function useSuspend(): <T>(fn: () => Promise<T>) => Promise<T> {
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const isTTY = Boolean(stdout.isTTY);
    if (isTTY) stdout.write(MOUSE_DISABLE + ALT_SCREEN_LEAVE);
    setRawMode(false);
    stdin.pause();
    try {
      return await fn();
    } finally {
      stdin.resume();
      setRawMode(true);
      if (isTTY) stdout.write(ALT_SCREEN_ENTER + MOUSE_ENABLE);
    }
  };
}
