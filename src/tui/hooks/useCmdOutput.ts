import { useCallback, useEffect, useRef, useState } from "react";
import type { CliRunResult } from "../cliRunner.js";
import type { View } from "../App.js";

export interface CmdState {
  title: string;
  running: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The invocation, kept for `r` re-run. */
  name: string;
  extraArgs: string[];
  /** Monotonic run token — a stale resolution (same command re-run while the
   * first subprocess was still going) must not clobber the newer run. */
  token: number;
}

/**
 * cmdOutput-view domain: owns the palette-command output state (`cmd`) plus
 * its elapsed-run ticker, and `runPaletteCommand` — which spawns the CLI,
 * switches to the cmdOutput view, and lands the result guarded by a
 * monotonic token so a stale (superseded) subprocess resolution can never
 * clobber a newer run's state. `setCmd` is intentionally NOT exposed: the
 * only writer is `runPaletteCommand` itself; the view closes via `setView`
 * navigation, not by nulling `cmd`.
 */
export function useCmdOutput(
  runCliFn: (name: string, extraArgs: string[]) => Promise<CliRunResult>,
  setView: (v: View) => void,
): {
  cmd: CmdState | null;
  cmdElapsed: number;
  runPaletteCommand: (name: string, extraArgs: string[]) => void;
  showCmdResult: (name: string, extraArgs: string[], r: CliRunResult) => void;
} {
  const [cmd, setCmd] = useState<CmdState | null>(null);
  const [cmdElapsed, setCmdElapsed] = useState(0);

  // Elapsed ticker for a running palette command (1s resolution).
  useEffect(() => {
    if (!cmd?.running) return;
    setCmdElapsed(0);
    const id = setInterval(() => setCmdElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [cmd?.running, cmd?.token]);

  const cmdTokenRef = useRef(0);
  const runPaletteCommand = useCallback(
    (name: string, extraArgs: string[]) => {
      const title = ["junco", name, ...extraArgs].join(" ");
      const token = ++cmdTokenRef.current;
      setCmd({
        title,
        running: true,
        output: "",
        exitCode: null,
        timedOut: false,
        name,
        extraArgs,
        token,
      });
      setView("cmdOutput");
      void runCliFn(name, extraArgs).then((r) => {
        setCmd((prev) =>
          prev && prev.token === token
            ? { ...prev, running: false, output: r.output, exitCode: r.code, timedOut: r.timedOut }
            : prev,
        );
      });
    },
    [runCliFn, setView],
  );

  /** Land an already-completed result (a chat-draft submit that failed, spec
   * 2026-09-01 §6.6) in the cmdOutput view. name/extraArgs are kept so `r`
   * re-runs the same invocation — the token is bumped like a real run's so a
   * still-in-flight palette command can never overwrite it on resolution. */
  const showCmdResult = useCallback(
    (name: string, extraArgs: string[], r: CliRunResult): void => {
      const token = ++cmdTokenRef.current;
      setCmd({
        title: ["junco", name, ...extraArgs].join(" "),
        running: false,
        output: r.output,
        exitCode: r.code,
        timedOut: r.timedOut,
        name,
        extraArgs,
        token,
      });
      setView("cmdOutput");
    },
    [setView],
  );

  return { cmd, cmdElapsed, runPaletteCommand, showCmdResult };
}
