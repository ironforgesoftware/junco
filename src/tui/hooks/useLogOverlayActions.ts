import { useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { LogEntry } from "../../logReader.js";
import { cycleLevel, distinctTickets, type LogFilters } from "../logFilter.js";

export interface LogOverlayActionsInput {
  /** The shared close recipe — App owns it because the overlay is only one of
   * the surfaces it closes (see App's `closeSurface`). */
  close: () => void;
  logEntries: LogEntry[];
  logFilters: LogFilters;
  logFollow: boolean;
  setLogFilters: Dispatch<SetStateAction<LogFilters>>;
  setLogFollow: Dispatch<SetStateAction<boolean>>;
  /** useScroll's jump-to-tail — pausing follow lands there first. */
  toEnd: () => void;
}

/**
 * The full-screen log overlay's slice of the id-keyed action table (#350):
 * the handlers behind the overlay's own mnemonic chips and keys. Split out of
 * App's one 56-dep `actionHandlers` memo by the switch's own discriminant —
 * this arm is selected whenever `logOverlay` is open, ahead of the view
 * switch, exactly as the original did.
 */
export function useLogOverlayActions({
  close,
  logEntries,
  logFilters,
  logFollow,
  setLogFilters,
  setLogFollow,
  toEnd,
}: LogOverlayActionsInput): Record<string, () => void> {
  return useMemo(
    () => ({
      close,
      follow: () => {
        // Pause lands at the tail first (toEnd) so the paused window shows
        // the newest lines, not a jump to the top.
        if (logFollow) {
          setLogFollow(false);
          toEnd();
        } else {
          setLogFollow(true);
        }
      },
      level: () => setLogFilters((f) => ({ ...f, minLevel: cycleLevel(f.minLevel) })),
      ticket: () => {
        // Cycle null (all) → each ticket present in the buffer → back to null.
        const opts: (string | null)[] = [null, ...distinctTickets(logEntries)];
        const idx = opts.indexOf(logFilters.ticket);
        setLogFilters((f) => ({ ...f, ticket: opts[(idx + 1) % opts.length] }));
      },
    }),
    [close, logEntries, logFilters.ticket, logFollow, setLogFilters, setLogFollow, toEnd],
  );
}
