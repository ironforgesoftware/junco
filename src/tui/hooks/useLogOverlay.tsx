import { useState } from "react";
import { useLogTail } from "../useLogTail.js";
import { type LogFilters } from "../logFilter.js";
import type { LogReaderDeps } from "../../logReader.js";
import type { LocalSection } from "../localSnapshot.js";
import type { View } from "../App.js";

/**
 * log-overlay domain: owns the full-screen log overlay's four state values
 * (`logOverlay`/`logFollow`/`logFilters`/`logSearchMode`), the derived
 * `logActive` gate, the `useLogTail` wiring (`logEntries`), and `onLogExpand`
 * (both open paths — the compact section's expand handler and the logs rail
 * Enter — route through it so opening always starts tailing live).
 *
 * `handleLogOverlayInput` stays in App: its tail dispatches through the
 * App-level `bindings.keymap` + `actionHandlers` derivation stack (computed
 * later in App from state this hook doesn't own), the same coupling
 * `useReview`/`usePalette` document for their own input cascades. App reads
 * this hook's exposed setters/`onLogExpand` from its cascade, memos, and JSX.
 */
export function useLogOverlay({
  logPath,
  logsPollMs,
  logReaderDeps,
  sysSection,
  view,
}: {
  logPath: string;
  logsPollMs?: number;
  /** useLogTail fs seam (tests inject an in-memory file); production omits it
   * — MUST stay `undefined` so the hook's effect dep array keeps a stable
   * identity and never teardown/re-seeds per render. Pass straight through. */
  logReaderDeps?: LogReaderDeps;
  sysSection: LocalSection | null;
  view: View;
}): {
  logOverlay: boolean;
  logFollow: boolean;
  logFilters: LogFilters;
  logSearchMode: boolean;
  logEntries: ReturnType<typeof useLogTail>;
  logActive: boolean;
  setLogOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  setLogFollow: React.Dispatch<React.SetStateAction<boolean>>;
  setLogFilters: React.Dispatch<React.SetStateAction<LogFilters>>;
  setLogSearchMode: React.Dispatch<React.SetStateAction<boolean>>;
  onLogExpand: () => void;
} {
  // The full-screen log overlay's open flag. Keeping the poll active while
  // it's open lives in `logActive` below.
  const [logOverlay, setLogOverlay] = useState(false);
  // Overlay filter/follow state, live only while the overlay is open. `follow`
  // pins the tail (● following); a scrollback key pauses it (⏸ paused). The
  // filters cycle via keys and render as display-only chips. `searchMode` routes
  // printable keys into the search term instead of the overlay's key recipes.
  const [logFollow, setLogFollow] = useState(true);
  const [logFilters, setLogFilters] = useState<LogFilters>({
    minLevel: "info",
    ticket: null,
    search: "",
  });
  const [logSearchMode, setLogSearchMode] = useState(false);

  // LOCAL logs tail — the hook reads disk ONLY while the logs surface is on
  // screen (the section is selected, or the overlay is open). `logReaderDeps`
  // is passed by IDENTITY (undefined in production, a stable fake in tests) so
  // the hook's effect never teardown/re-seeds per render; the resolved `pollMs`
  // primitive and that identity are what its dep array reads, not this literal.
  const logActive = (view === "main" && sysSection === "logs") || logOverlay;
  const logEntries = useLogTail(logPath, logActive, {
    pollMs: logsPollMs,
    readerDeps: logReaderDeps,
  });

  // Both open paths (click on the compact pane, and the logs rail Enter) route
  // here so opening ALWAYS starts tailing live (tail -f / less +F convention) —
  // a follow state left paused from a prior session would otherwise reopen at
  // the top. Filters intentionally persist across reopen; only follow resets.
  const onLogExpand = (): void => {
    setLogFollow(true);
    setLogOverlay(true);
  };

  return {
    logOverlay,
    logFollow,
    logFilters,
    logSearchMode,
    logEntries,
    logActive,
    setLogOverlay,
    setLogFollow,
    setLogFilters,
    setLogSearchMode,
    onLogExpand,
  };
}
