/** FTUE switcher (spec §4): one Ink root hosts either the setup walkthrough
 * or the dashboard. No config → WizardApp (fresh); outcome written/unchanged
 * → load the just-written config → App; App may request a re-run (palette
 * "setup") → WizardApp (rerun) → config-reloaded App. The exits: a FRESH-mode
 * cancel (130) and a failed wizard-io build (1, corrupt-config race below). */
import React, { useState } from "react";
import { Text, useApp } from "ink";
import type { Config } from "../types.js";
import type { WizardOutcome } from "../wizard/io.js";
import type { WizardIoResult } from "../wizard.js";
import { App } from "./App.js";
import { WizardApp } from "./wizard/WizardApp.js";

export interface RootProps {
  configPath: string;
  initialConfig: Config | null; // null → FTUE: wizard first
  buildAppProps: (cfg: Config) => Omit<React.ComponentProps<typeof App>, "onRequestWizard">;
  makeWizardIo: () => WizardIoResult;
  loadConfigFn: (p: string) => Config;
  /** 130 on a FTUE cancel; 1 when the wizard io fails to build (a config
   * corrupted between the cli existence check and the build). Never called on
   * completion or a re-run cancel — those stay inside the dashboard. */
  onFinalExitCode: (code: number) => void;
}

export function Root({
  configPath,
  initialConfig,
  buildAppProps,
  makeWizardIo,
  loadConfigFn,
  onFinalExitCode,
}: RootProps): React.JSX.Element {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config | null>(initialConfig);
  // Amendment 2: one lazy build per FTUE mount holding the WHOLE result — the
  // brief's skeleton called makeWizardIo() twice (in two initializers), which
  // would build the io (and, in rerun mode, re-read the file) twice. Hold the
  // result; derive io/error from it. `null` means "no wizard showing" (App).
  const [wizard, setWizard] = useState<WizardIoResult | null>(() =>
    initialConfig === null ? makeWizardIo() : null,
  );

  const onOutcome = (o: WizardOutcome): void => {
    if (o === "cancelled") {
      if (cfg === null) {
        onFinalExitCode(130); // FTUE cancel — nothing to fall back to
        exit();
        return;
      }
      setWizard(null); // re-run cancel: dashboard resumes, config untouched
      return;
    }
    // written/unchanged: reload the just-written config and remount App fresh.
    setCfg(loadConfigFn(configPath));
    setWizard(null);
  };

  if (wizard !== null && !wizard.ok) {
    // Unreachable in fresh mode (no file to be invalid); guards a corrupt
    // config racing between the cli existence check and the wizard build.
    onFinalExitCode(1);
    exit();
    return <Text color="red">✗ {wizard.error}</Text>;
  }
  if (wizard !== null) return <WizardApp io={wizard.value.io} onOutcome={onOutcome} />;
  // Defensive, and unreachable in practice: a FTUE cancel exits with the wizard
  // still mounted (the `wizard !== null` branch above returns first), and every
  // non-cancel outcome sets cfg before clearing wizard. This guards the
  // Config | null type so App is never handed a null config.
  if (cfg === null) return <Text> </Text>;
  return (
    <App
      {...buildAppProps(cfg)}
      onRequestWizard={() => {
        setWizard(makeWizardIo());
      }}
    />
  );
}
