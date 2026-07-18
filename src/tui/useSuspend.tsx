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
 * TTY-gated like MouseProvider — under ink-testing-library's fake streams
 * only raw mode toggles and the provider state change are observable. Without
 * a SuspendProvider ancestor the hook degrades to the old behavior (begin()
 * resolves immediately). */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const { begin, end } = useContext(SuspendContext);
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    await begin();
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
      end();
    }
  };
}
