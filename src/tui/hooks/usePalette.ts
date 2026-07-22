import { useState, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { filterCommands } from "../components/CommandPalette.js";
import { PALETTE_COMMANDS } from "../cliRunner.js";
import type { View } from "../App.js";
import type { ToastKind } from "../theme.js";

/**
 * palette-view domain: owns the four palette state values plus `paletteEnter`
 * (the command-resolution/dispatch logic) and `resetPalette` (the 4-line
 * reset that runs whenever the palette is (re)opened). The keyboard input
 * cascade (~App's `view === "palette"` branch) and the CommandPalette JSX
 * props stay in App.tsx — they read/write the exposed setters and
 * `paletteEnter` directly, the same coupling `useReview` documents for its
 * own cascade.
 */
export function usePalette({
  runPaletteCommand,
  showToast,
  onRequestWizard,
  setView,
}: {
  runPaletteCommand: (name: string, extraArgs: string[]) => void;
  showToast: (kind: ToastKind, text: string) => void;
  onRequestWizard?: () => void;
  setView: (v: View) => void;
}): {
  paletteFilter: string;
  paletteSel: number;
  paletteArgsMode: boolean;
  paletteArgs: string;
  setPaletteFilter: Dispatch<SetStateAction<string>>;
  setPaletteSel: Dispatch<SetStateAction<number>>;
  setPaletteArgsMode: Dispatch<SetStateAction<boolean>>;
  setPaletteArgs: Dispatch<SetStateAction<string>>;
  resetPalette: () => void;
  paletteEnter: () => void;
} {
  const [paletteFilter, setPaletteFilter] = useState("");
  const [paletteSel, setPaletteSel] = useState(0);
  const [paletteArgsMode, setPaletteArgsMode] = useState(false);
  const [paletteArgs, setPaletteArgs] = useState("");

  const resetPalette = useCallback(() => {
    setPaletteFilter("");
    setPaletteSel(0);
    setPaletteArgsMode(false);
    setPaletteArgs("");
  }, []);

  const paletteEnter = useCallback(() => {
    const visible = filterCommands(PALETTE_COMMANDS, paletteFilter);
    const current = visible[Math.min(paletteSel, Math.max(0, visible.length - 1))];
    if (!current) return;
    if (current.name === "setup") {
      // In-process: swap the Root host to the wizard instead of spawning a
      // subprocess (there's no `junco setup` subcommand — the wizard can't
      // nest a second Ink render inside this one).
      setView("main");
      onRequestWizard?.();
      return;
    }
    if (current.excluded !== null) {
      showToast("info", `${current.name}: ${current.excluded}`);
      return;
    }
    if (current.argsHint && !paletteArgsMode) {
      setPaletteArgsMode(true);
      return;
    }
    const typed = paletteArgs.split(/\s+/).filter(Boolean);
    const extraArgs = typed.length > 0 ? typed : current.defaultArgs;
    runPaletteCommand(current.name, extraArgs);
  }, [
    paletteFilter,
    paletteSel,
    paletteArgsMode,
    paletteArgs,
    runPaletteCommand,
    showToast,
    onRequestWizard,
    setView,
  ]);

  return {
    paletteFilter,
    paletteSel,
    paletteArgsMode,
    paletteArgs,
    setPaletteFilter,
    setPaletteSel,
    setPaletteArgsMode,
    setPaletteArgs,
    resetPalette,
    paletteEnter,
  };
}
