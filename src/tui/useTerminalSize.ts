import { useWindowSize } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Ink's useWindowSize with a test seam: ink-testing-library has no resizable
 * stdout, so tests inject a fixed size. Falls back to 100×30 when the stream
 * reports nothing (non-TTY). The hook is called unconditionally (rules of hooks). */
export function useTerminalSize(override?: TerminalSize): TerminalSize {
  const ws = useWindowSize();
  if (override) return override;
  return { columns: ws.columns || 100, rows: ws.rows || 30 };
}
