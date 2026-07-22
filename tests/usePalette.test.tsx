// tests/usePalette.test.tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { usePalette } from "../src/tui/hooks/usePalette.js";
import type { View } from "../src/tui/App.js";
import type { ToastKind } from "../src/tui/theme.js";
import { until } from "./helpers/until.js";

function Probe({
  runPaletteCommand,
  showToast,
  onRequestWizard,
  setView,
  onReady,
}: {
  runPaletteCommand: (name: string, extraArgs: string[]) => void;
  showToast: (kind: ToastKind, text: string) => void;
  onRequestWizard?: () => void;
  setView: (v: View) => void;
  onReady: (api: ReturnType<typeof usePalette>) => void;
}) {
  const api = usePalette({ runPaletteCommand, showToast, onRequestWizard, setView });
  onReady(api);
  return (
    <Text>
      {`filter:${api.paletteFilter}:sel:${api.paletteSel}:argsMode:${api.paletteArgsMode}:args:${api.paletteArgs}`}
    </Text>
  );
}

describe("usePalette", () => {
  it("paletteEnter on a normal command calls runPaletteCommand with the resolved args", async () => {
    const runPaletteCommand = vi.fn();
    const showToast = vi.fn();
    const onRequestWizard = vi.fn();
    const setView = vi.fn();
    let api!: ReturnType<typeof usePalette>;
    const r = render(
      <Probe
        runPaletteCommand={runPaletteCommand}
        showToast={showToast}
        onRequestWizard={onRequestWizard}
        setView={setView}
        onReady={(a) => (api = a)}
      />,
    );

    // "status" has no argsHint and is not excluded — filtering to it isolates
    // a single, deterministic row (see PALETTE_COMMANDS in cliRunner.ts).
    api.setPaletteFilter("status");
    await until(() => api.paletteFilter === "status");
    api.paletteEnter();
    expect(runPaletteCommand).toHaveBeenCalledWith("status", []);
    expect(onRequestWizard).not.toHaveBeenCalled();
    r.unmount();
  });

  it('paletteEnter on "setup" calls onRequestWizard + setView("main"), not runPaletteCommand', async () => {
    const runPaletteCommand = vi.fn();
    const showToast = vi.fn();
    const onRequestWizard = vi.fn();
    const setView = vi.fn();
    let api!: ReturnType<typeof usePalette>;
    const r = render(
      <Probe
        runPaletteCommand={runPaletteCommand}
        showToast={showToast}
        onRequestWizard={onRequestWizard}
        setView={setView}
        onReady={(a) => (api = a)}
      />,
    );

    api.setPaletteFilter("setup");
    await until(() => api.paletteFilter === "setup");
    api.paletteEnter();
    expect(setView).toHaveBeenCalledWith("main");
    expect(onRequestWizard).toHaveBeenCalledTimes(1);
    expect(runPaletteCommand).not.toHaveBeenCalled();
    r.unmount();
  });

  it("paletteEnter on a command with an argsHint flips argsMode without running it", async () => {
    const runPaletteCommand = vi.fn();
    const showToast = vi.fn();
    const onRequestWizard = vi.fn();
    const setView = vi.fn();
    let api!: ReturnType<typeof usePalette>;
    const r = render(
      <Probe
        runPaletteCommand={runPaletteCommand}
        showToast={showToast}
        onRequestWizard={onRequestWizard}
        setView={setView}
        onReady={(a) => (api = a)}
      />,
    );

    // "logs" has argsHint "[-n N]" and argsMode starts false.
    api.setPaletteFilter("logs");
    await until(() => api.paletteFilter === "logs");
    expect(api.paletteArgsMode).toBe(false);
    api.paletteEnter();
    await until(() => api.paletteArgsMode === true);
    expect(runPaletteCommand).not.toHaveBeenCalled();
    r.unmount();
  });

  it("resetPalette clears all four palette state values", async () => {
    const runPaletteCommand = vi.fn();
    const showToast = vi.fn();
    const setView = vi.fn();
    let api!: ReturnType<typeof usePalette>;
    const r = render(
      <Probe
        runPaletteCommand={runPaletteCommand}
        showToast={showToast}
        setView={setView}
        onReady={(a) => (api = a)}
      />,
    );

    api.setPaletteFilter("logs");
    api.setPaletteSel(2);
    api.setPaletteArgsMode(true);
    api.setPaletteArgs("-n 50");
    await until(
      () =>
        api.paletteFilter === "logs" &&
        api.paletteSel === 2 &&
        api.paletteArgsMode === true &&
        api.paletteArgs === "-n 50",
    );

    api.resetPalette();
    await until(
      () =>
        api.paletteFilter === "" &&
        api.paletteSel === 0 &&
        api.paletteArgsMode === false &&
        api.paletteArgs === "",
    );
    r.unmount();
  });
});
