/** Suspend the Ink session around an interactive child process (gh's
 * device-flow login): blank the UI, drop raw mode, pause stdin, disable mouse
 * reporting, and leave the alt screen so the child owns the real terminal;
 * restore everything afterwards.
 *
 * Suspension is app state, not just a side effect (#214): SuspendProvider
 * keeps its children MOUNTED but rendered `display:none`, so the frame Ink
 * writes while suspended is empty — begin() resolves only after that empty
 * frame has committed (log-update erases the old frame while still inside the
 * alt screen), which is what stops React commits from painting the wizard
 * into the normal buffer on top of the child's own prompts. On resume the
 * next commit diffs against the empty frame, so Ink rewrites the whole UI
 * instead of diffing against a frame the cleared alt screen no longer shows.
 *
 * Raw mode is dropped on the STREAM ITSELF, not via Ink's setRawMode: that
 * wrapper is reference-counted (ink App's rawModeEnabledCount, real
 * stdin.setRawMode only at 0/1 crossings), and the still-mounted useInput
 * consumers under display:none hold the count above zero — a counted
 * "disable" can never actually restore cooked mode, leaving gh's line-read
 * waiting for a "\n" that ICRNL never produces (#216). The suspended tree is
 * static, so Ink performs no 0/1 crossing that could re-raw the tty while the
 * child owns it; on resume the tty is returned raw — exactly the state Ink's
 * count believes it is in.
 *
 * TTY-gated like MouseProvider — under ink-testing-library's fake streams
 * (no isTTY) neither raw mode nor escapes are touched. Without a
 * SuspendProvider ancestor the hook degrades to pause/resume only (begin()
 * resolves immediately). */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, useStdin, useStdout } from "ink";
import { MOUSE_DISABLE, MOUSE_ENABLE } from "./mouse.js";

const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";

interface SuspendApi {
  /** Blank the UI; resolves after the empty frame has committed. */
  begin: () => Promise<void>;
  /** Restore the UI (next commit repaints in full from the empty frame). */
  end: () => void;
}

const noopApi: SuspendApi = { begin: async () => {}, end: () => {} };
const SuspendContext = createContext<SuspendApi>(noopApi);

export function SuspendProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [suspended, setSuspended] = useState(false);
  const suspendedRef = useRef(false);
  const waiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    // Passive effects run after Ink's resetAfterCommit has written the frame,
    // so by the time this fires the blank frame is on the wire.
    if (suspended) for (const release of waiters.current.splice(0)) release();
  }, [suspended]);
  const api = useMemo<SuspendApi>(
    () => ({
      begin: () =>
        new Promise<void>((resolve) => {
          if (suspendedRef.current) {
            resolve(); // already blank — a state no-op would never re-fire the effect
            return;
          }
          suspendedRef.current = true;
          waiters.current.push(resolve);
          setSuspended(true);
        }),
      end: () => {
        suspendedRef.current = false;
        setSuspended(false);
      },
    }),
    [],
  );
  return (
    <SuspendContext.Provider value={api}>
      {/* display:none (not conditional null): children stay mounted so
          chapter state survives the suspension — unmounting here would reset
          Account mid-login. */}
      <Box display={suspended ? "none" : "flex"} flexDirection="column">
        {children}
      </Box>
    </SuspendContext.Provider>
  );
}

export function useSuspend(): <T>(fn: () => Promise<T>) => Promise<T> {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { begin, end } = useContext(SuspendContext);
  // useCallback'd: every dep here is context-stable, and a fresh identity per
  // render would churn the dep arrays of the callbacks that suspend around a
  // child process (useChatDrafts' `edit`), defeating their memoization.
  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      await begin();
      const outTTY = Boolean(stdout.isTTY);
      if (outTTY) stdout.write(MOUSE_DISABLE + ALT_SCREEN_LEAVE);
      // Directly on the stream — NOT Ink's counted setRawMode (see header).
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      try {
        return await fn();
      } finally {
        stdin.resume();
        if (stdin.isTTY) stdin.setRawMode(true);
        if (outTTY) stdout.write(ALT_SCREEN_ENTER + MOUSE_ENABLE);
        end();
      }
    },
    [stdin, stdout, begin, end],
  );
}
